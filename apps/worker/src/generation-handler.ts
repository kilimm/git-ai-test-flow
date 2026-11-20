// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createEncryptionKey, SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  AuditLogWriter,
  CredentialRepository,
  FeatureIndexRepository,
  GenerationFileRepository,
  GenerationRepository,
  LlmProfileRepository,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, Generation, Project } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE } from '@gait/shared';
import type { DiffCollection } from '@gait/shared';
import {
  PROMPT_VERSION,
  createLlmClient,
  reindexSuite,
  retrieveCasesForFeaturePoints,
  runGenerationWorkflow,
} from '@gait/agent';
import type { LlmClient } from '@gait/agent';
import {
  SuiteRepository,
  addWorktree,
  collectCurrentDiff,
  collectRangeDiff,
  ensureDirectory,
  filterDiffFiles,
  removeWorktree,
  resolveCommit,
  syncMirror,
} from '@gait/git';
import type { GitAuth } from '@gait/git';
import { StepRegistry, parseSuiteStepCatalog } from '@gait/runner';
import type { JobHandler } from './job-handler.js';
import type { WorkerLogger } from './worker.js';

export interface GenerationHandlerOptions {
  db: AppDatabase;
  env: AppEnv;
  logger?: WorkerLogger;
  llmClientFactory?: (config: Parameters<typeof createLlmClient>[0]) => LlmClient;
  now?: () => number;
}

function payloadGenerationId(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { generationId?: unknown }).generationId !== 'string'
  ) {
    throw new Error('generation.run payload must contain generationId');
  }

  return (payload as { generationId: string }).generationId;
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,})/g, '****').slice(0, 500);
}

/** Worker 侧 Graph A 执行器：解析配置、拉取 diff、调用 LLM 并持久化审批草稿。 */
export function createGenerationJobHandler(options: GenerationHandlerOptions): JobHandler {
  const { db, env } = options;
  const clock = options.now ?? (() => Date.now());
  const cipher = new SecretCipher(
    createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION),
  );
  const auditWriter = new AuditLogWriter(db);
  const llmClientFactory = options.llmClientFactory ?? createLlmClient;

  function decrypt(
    tenantId: string,
    credential: {
      id: string;
      type: string;
      secretCiphertext: Buffer;
      secretIv: Buffer;
      secretAuthTag: Buffer;
      keyVersion: number;
    },
  ): string {
    return cipher.decrypt(tenantId, credential.id, credential.type, {
      ciphertext: credential.secretCiphertext,
      iv: credential.secretIv,
      authTag: credential.secretAuthTag,
      keyVersion: credential.keyVersion,
    });
  }

  return async (context) => {
    const generationId = payloadGenerationId(context.payload);
    const tenantId = context.job.tenantId;

    if (tenantId === null) {
      throw new Error('generation.run job is missing tenantId');
    }

    const generationRepository = new GenerationRepository(db, tenantId);
    const generationFileRepository = new GenerationFileRepository(db, tenantId);
    const generation = generationRepository.findById(generationId);

    if (generation === undefined) {
      throw new Error(`Generation not found: ${generationId}`);
    }

    if (
      generation.status === 'committed' ||
      generation.status === 'rejected' ||
      generation.status === 'no_op'
    ) {
      return;
    }

    generationRepository.update(generation.id, { status: 'running' }, clock());
    let suite: SuiteRepository | undefined;
    let worktreePath: string | undefined;
    let productMirrorPath: string | undefined;
    let project: Project | undefined;

    try {
      project = new ProjectRepository(db, tenantId).findById(generation.projectId);

      if (project === undefined) {
        throw new Error('Project not found');
      }

      const credentials = new CredentialRepository(db, tenantId);
      let gitAuth: GitAuth | null = null;

      if (project.gitCredentialId !== null) {
        const credential = credentials.findById(project.gitCredentialId);

        if (credential !== undefined && credential.type === CREDENTIAL_TYPE.GIT_PAT) {
          gitAuth = {
            ...(credential.username === null ? {} : { username: credential.username }),
            token: decrypt(tenantId, credential),
          };
        }
      }

      const profiles = new LlmProfileRepository(db, tenantId)
        .listByProject(project.id)
        .filter((profile) => profile.enabled && profile.purpose === 'generation');

      if (profiles.length === 0) {
        throw new Error('No enabled generation LLM profile is configured');
      }

      const profile = profiles[0];

      if (profile === undefined) {
        throw new Error('No enabled generation LLM profile is configured');
      }

      let apiKey: string | undefined;

      if (profile.credentialId !== null) {
        const llmCredential = credentials.findById(profile.credentialId);

        if (llmCredential === undefined || llmCredential.type !== CREDENTIAL_TYPE.LLM_API_KEY) {
          throw new Error('Generation LLM credential is missing or has the wrong type');
        }

        apiKey = decrypt(tenantId, llmCredential);
      }

      const params = parseParams(profile.paramsJson);
      const llm = llmClientFactory({
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey,
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
        ...(typeof params.maxTokens === 'number' ? { maxTokens: params.maxTokens } : {}),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      });

      suite = await SuiteRepository.open({
        mode: project.suiteMode,
        projectId: project.id,
        projectSlug: project.slug,
        projectRepoUrl: project.productRepoUrl,
        suiteRepoUrl: project.suiteRepoUrl,
        suitePath: project.suitePath,
        featureRoot: project.featureRoot,
        dataDir: env.DATA_DIR,
        headSha: generation.headSha,
        auth: gitAuth,
        signal: context.signal,
      });

      const registry = StepRegistry.createDefault(
        parseSuiteStepCatalog(suite.readFile('steps/registry.json')),
      );
      const index = new FeatureIndexRepository(db, tenantId);
      await reindexSuite({ suite, featureIndex: index, projectId: project.id });

      productMirrorPath = join(env.DATA_DIR, 'git', 'mirrors', `product-${project.id}.git`);
      await syncMirror({
        repoUrl: project.productRepoUrl,
        mirrorPath: productMirrorPath,
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });

      const headRef =
        generation.headSha === 'HEAD'
          ? (generation.branch ?? project.defaultBranch)
          : generation.headSha;
      const resolvedHead = await resolveCommit(productMirrorPath, headRef, {
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });
      let collection: DiffCollection;

      if (generation.mode === 'range') {
        if (generation.baseSha === null) {
          throw new Error('Range generation requires baseSha');
        }

        const raw = await collectRangeDiff({
          repoPath: productMirrorPath,
          baseSha: generation.baseSha,
          headSha: resolvedHead,
          ...(gitAuth === null ? {} : { auth: gitAuth }),
          signal: context.signal,
        });
        const filtered = filterDiffFiles(raw.files);
        collection = {
          mode: 'range',
          baseSha: raw.baseSha,
          headSha: raw.headSha,
          branch: generation.branch,
          commits: raw.commits,
          files: filtered.files,
          stats: filtered.stats,
          truncated: filtered.stats.truncatedFiles > 0,
        };
      } else {
        const worktreesRoot = join(env.DATA_DIR, 'git', 'worktrees');
        ensureDirectory(worktreesRoot);
        worktreePath = mkdtempSync(join(worktreesRoot, 'gen-'));
        await addWorktree({
          mirrorPath: productMirrorPath,
          worktreePath,
          ref: resolvedHead,
          ...(gitAuth === null ? {} : { auth: gitAuth }),
          signal: context.signal,
        });
        const raw = await collectCurrentDiff({
          repoPath: worktreePath,
          ...(gitAuth === null ? {} : { auth: gitAuth }),
          signal: context.signal,
        });
        const filtered = filterDiffFiles(raw.files);
        collection = {
          mode: 'current',
          baseSha: null,
          headSha: raw.headSha,
          branch: generation.branch,
          commits: raw.commits,
          files: filtered.files,
          stats: filtered.stats,
          truncated: filtered.stats.truncatedFiles > 0,
        };
      }

      const workflow = await runGenerationWorkflow(
        {
          llm,
          collectDiff: async () => collection,
          stepRegistry: registry,
          retrieveExistingCases: async (featurePoints) =>
            retrieveCasesForFeaturePoints(generation.projectId, index, featurePoints),
          featurePrefix: suite.featurePrefix,
        },
        {
          tenantId,
          projectId: project.id,
          generationId: generation.id,
          baseSha: collection.baseSha,
          headSha: collection.headSha,
          branch: generation.branch,
          mode: collection.mode,
          model: profile.model,
          promptVersion: PROMPT_VERSION,
          selection: parseSelection(generation),
        },
      );

      if (workflow.outcome === 'failed') {
        generationRepository.update(
          generation.id,
          {
            status: 'failed',
            errorJson: JSON.stringify({ reason: workflow.state.failureReason }),
            featurePointsJson: JSON.stringify(workflow.state.featurePoints),
            statsJson: JSON.stringify(workflow.stats),
            finishedAt: clock(),
          },
          clock(),
        );
        auditWriter.append({
          tenantId,
          action: AUDIT_ACTION.GENERATION_FAIL,
          resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
          resourceId: generation.id,
          detail: { reason: workflow.state.failureReason },
        });

        return;
      }

      if (workflow.outcome === 'no_op') {
        generationRepository.update(
          generation.id,
          {
            status: 'no_op',
            featurePointsJson: JSON.stringify(workflow.state.featurePoints),
            statsJson: JSON.stringify(workflow.stats),
            baseSha: collection.baseSha,
            headSha: collection.headSha,
            finishedAt: clock(),
          },
          clock(),
        );

        return;
      }

      const validation = workflow.state.validation;

      if (validation === null || !validation.valid) {
        throw new Error('Workflow reached approval without valid drafts');
      }

      generationFileRepository.replaceForGeneration(
        generation.id,
        workflow.state.drafts.map((draft) => {
          const validated = validation.files.find((file) => file.path === draft.path);

          return {
            path: draft.path,
            action: draft.action,
            content: draft.content,
            contentHash: validated?.contentHash ?? '',
            scenarioCount: validated?.scenarioCount ?? 0,
            validationStatus: validated?.validationStatus ?? 'invalid',
            validationErrors: validated?.issues ?? [],
          };
        }),
      );
      generationRepository.update(
        generation.id,
        {
          status: 'awaiting_approval',
          approvalStatus: 'pending',
          featurePointsJson: JSON.stringify(workflow.state.featurePoints),
          statsJson: JSON.stringify(workflow.stats),
          model: profile.model,
          promptVersion: PROMPT_VERSION,
          workflowThreadId: `generation:${generation.id}`,
          errorJson: null,
          baseSha: collection.baseSha,
          headSha: collection.headSha,
        },
        clock(),
      );
    } catch (error) {
      generationRepository.update(
        generation.id,
        {
          status: 'failed',
          errorJson: JSON.stringify({ reason: safeError(error) }),
          finishedAt: clock(),
        },
        clock(),
      );
      auditWriter.append({
        tenantId,
        action: AUDIT_ACTION.GENERATION_FAIL,
        resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
        resourceId: generation.id,
        detail: { reason: safeError(error) },
      });

      throw error;
    } finally {
      if (worktreePath !== undefined && productMirrorPath !== undefined) {
        await removeWorktree(productMirrorPath, worktreePath);
      }

      if (suite !== undefined) {
        await suite.dispose();
      }
    }
  };
}

function parseSelection(generation: Generation): { modules: string[] } | null {
  const stats = parseParams(generation.statsJson);
  const selection = stats.selection;

  if (
    selection !== null &&
    typeof selection === 'object' &&
    Array.isArray((selection as { modules?: unknown }).modules)
  ) {
    const modules = (selection as { modules: unknown[] }).modules.filter(
      (module): module is string => typeof module === 'string',
    );

    return modules.length === 0 ? null : { modules };
  }

  return null;
}
