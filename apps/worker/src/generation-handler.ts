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
  PromptTemplateRepository,
  ScriptLibraryRepository,
} from '@gait/db';
import type { AppDatabase, Generation, Project } from '@gait/db';import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  GENERATION_MODES,
  parseGranularity,
} from '@gait/shared';
import type { GenerationGranularity, GenerationMode } from '@gait/shared';
import type { DiffCollection } from '@gait/shared';
import {
  PROMPT_VERSION,
  createLlmClient,
  reindexSuite,
  retrieveCasesForFeaturePoints,
  runGenerationWorkflow,
} from '@gait/agent';
import type { LlmClient, PromptOverrides } from '@gait/agent';
import {
  SuiteRepository,
  addWorktree,
  collectCurrentDiff,
  collectRangeDiff,
  collectSnapshotDiff,
  ensureDirectory,
  filterDiffFiles,
  removeWorktree,
  resolveCommit,
  syncMirror,
} from '@gait/git';
import type { GitAuth } from '@gait/git';
import {
  StepRegistry,
  compileStepPattern,
  createScriptDraft,
  flattenFixtureVariables,
  formatScriptCatalog,
  parseFixtureDocument,
  restoreScriptLibrary,
  toStepDefinitions,
} from '@gait/runner';
import type { ScriptLibraryRepository as ScriptRepository } from '@gait/db';
import type { JobHandler } from './job-handler.js';

/**
 * 把模型的 stepProposals 落成脚本库 draft。
 *
 * - 已能匹配现有 pattern 的提议直接丢弃（说明只是模型没查目录）；
 * - 句式统一转成「固定前缀 + 占位符」形式，避免同一语义散成多个句式；
 * - 同名/同 pattern 冲突交给 createScriptDraft 判定并跳过。
 */
async function proposeScriptDrafts(input: {
  repository: ScriptRepository;
  proposals: readonly { keyword: string; text: string }[];
  existingPatterns: readonly string[];
  createdBy: string | null;
}): Promise<{ created: number; skipped: number }> {
  const compiled = input.existingPatterns.map((pattern) => compileStepPattern(pattern));
  let created = 0;
  let skipped = 0;

  for (const proposal of input.proposals) {
    const pattern = toProposalPattern(proposal.text);

    if (pattern === null) {
      skipped += 1;
      continue;
    }

    // 已经能被现有 step 匹配 → 不是缺口。
    if (compiled.some((regex) => regex.test(proposal.text.trim()))) {
      skipped += 1;
      continue;
    }

    const result = await createScriptDraft(
      input.repository,
      {
        moduleKey: moduleKeyOfPattern(pattern),
        name: nameOfPattern(pattern),
        kind: 'template',
        pattern,
        description: `生成的用例所需 step（来源：生成提案）。原始描述：${proposal.text.slice(0, 300)}`,
        params: [],
        examples: [],
        source: null,
        createdBy: input.createdBy,
      },
      compileStepPattern,
    );

    if (result.ok) {
      created += 1;
    } else {
      skipped += 1;
    }
  }

  return { created, skipped };
}

/** 把自然语言句式转成带占位符的 pattern：引号内容 → {string}，数字 → {int}。 */
function toProposalPattern(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (normalized.length === 0 || normalized.length > 300) {
    return null;
  }

  const pattern = normalized
    .replace(/"[^"]*"|'[^']*'/g, '{string}')
    .replace(/\b\d+\b/g, '{int}')
    .toLowerCase();

  // 太长或没有固定前缀的句式不适合做 pattern。
  return pattern.replace(/\{string\}|\{int\}/g, '').trim().length < 4 ? null : pattern;
}

function moduleKeyOfPattern(pattern: string): string {
  if (pattern.includes('database') || pattern.includes(' sql')) {
    return 'db.query';
  }

  if (pattern.startsWith('i send') || pattern.includes('response') || pattern.includes(' header')) {
    return 'api.request';
  }

  if (pattern.startsWith('i click') || pattern.startsWith('i fill') || pattern.includes('page')) {
    return 'ui.form';
  }

  return 'common';
}

function nameOfPattern(pattern: string): string {
  const slug = pattern
    .replace(/\{string\}|\{int\}|\{anything\}|\{[a-z]+\}/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `proposal-${slug.length === 0 ? 'step' : slug}`;
}
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
    const generation = await generationRepository.findById(generationId);

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

    await generationRepository.update(generation.id, { status: 'running' }, clock());
    let suite: SuiteRepository | undefined;
    let worktreePath: string | undefined;
    let productMirrorPath: string | undefined;
    let project: Project | undefined;

    try {
      project = await new ProjectRepository(db, tenantId).findById(generation.projectId);

      if (project === undefined) {
        throw new Error('Project not found');
      }

      const credentials = new CredentialRepository(db, tenantId);
      let gitAuth: GitAuth | null = null;

      if (project.gitCredentialId !== null) {
        const credential = await credentials.findById(project.gitCredentialId);

        if (credential !== undefined && credential.type === CREDENTIAL_TYPE.GIT_PAT) {
          gitAuth = {
            ...(credential.username === null ? {} : { username: credential.username }),
            token: decrypt(tenantId, credential),
          };
        }
      }

      const profiles = (
        await new LlmProfileRepository(db, tenantId).listByProject(project.id)
      ).filter((profile) => profile.enabled && profile.purpose === 'generation');

      if (profiles.length === 0) {
        throw new Error('No enabled generation LLM profile is configured');
      }

      const profile = profiles[0];

      if (profile === undefined) {
        throw new Error('No enabled generation LLM profile is configured');
      }

      // 提示词覆盖（tenant 级自定义）+ 本次任务额外需求，由 workflow 在各阶段注入。
      const promptOverrides = await resolvePromptOverrides(db, tenantId);

      let apiKey: string | undefined;

      if (profile.credentialId !== null) {
        const llmCredential = await credentials.findById(profile.credentialId);

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

      // 脚本库（tenant 级）是事实源：先把脚本还原到 suite，再据此构建注册表与脚本目录。
      const scriptRepository = new ScriptLibraryRepository(db, tenantId);
      const libraryEntries = await scriptRepository.listActive();

      if (libraryEntries.length > 0) {
        restoreScriptLibrary({ suite, entries: libraryEntries });
      }

      const registry = StepRegistry.fromLibrary(toStepDefinitions(libraryEntries));
      const scriptCatalog =
        libraryEntries.length === 0
          ? undefined
          : formatScriptCatalog(libraryEntries, { maxSteps: 60 });
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
      const mode = resolveMode(generation.mode);
      const granularity = resolveGranularity(generation);
      let collection: DiffCollection;

      if (mode === 'baseline') {
        // baseline：忽略 diff，以空树为 base 对整个代码库快照做全量分析。
        // 大仓库可能超过 1.5MB diff 预算或 200 文件上限，filterDiffFiles 会按优先级裁剪，
        // 裁剪结果通过 stats（truncatedFiles / skippedFiles / incomplete）透出，不静默丢弃。
        const raw = await collectSnapshotDiff({
          repoPath: productMirrorPath,
          headSha: resolvedHead,
          ...(gitAuth === null ? {} : { auth: gitAuth }),
          signal: context.signal,
        });
        const filtered = filterDiffFiles(raw.files);
        collection = {
          mode: 'baseline',
          baseSha: raw.baseSha,
          headSha: raw.headSha,
          branch: generation.branch,
          commits: raw.commits.slice(0, 50),
          files: filtered.files,
          stats: filtered.stats,
          truncated: filtered.stats.truncatedFiles > 0 || filtered.stats.skippedFiles > 0,
        };
      } else if (mode === 'range') {
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

      const fixtureVariables = await loadFixtureVariables(suite);

      const workflow = await runGenerationWorkflow(
        {
          llm,
          collectDiff: async () => collection,
          stepRegistry: registry,
          promptOverrides,
          fixtureVariables,
          ...(scriptCatalog === undefined ? {} : { scriptCatalog }),
          retrieveExistingCases: async (featurePoints) =>
            await retrieveCasesForFeaturePoints(generation.projectId, index, featurePoints),
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
          granularity,
          extraInstructions: parseExtraInstructions(generation),
          model: profile.model,
          promptVersion: PROMPT_VERSION,
          selection: parseSelection(generation),
        },
      );

      if (workflow.outcome === 'failed') {
        await generationRepository.update(
          generation.id,
          {
            status: 'failed',
            errorJson: JSON.stringify({ reason: workflow.state.failureReason }),
            featurePointsJson: JSON.stringify(workflow.state.featurePoints),
            statsJson: JSON.stringify({
              ...workflow.stats,
              extraInstructions: parseExtraInstructions(generation),
            }),
            finishedAt: clock(),
          },
          clock(),
        );
        await auditWriter.append({
          tenantId,
          action: AUDIT_ACTION.GENERATION_FAIL,
          resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
          resourceId: generation.id,
          detail: { reason: workflow.state.failureReason },
        });

        return;
      }

      if (workflow.outcome === 'no_op') {
        await generationRepository.update(
          generation.id,
          {
            status: 'no_op',
            featurePointsJson: JSON.stringify(workflow.state.featurePoints),
            statsJson: JSON.stringify({
              ...workflow.stats,
              extraInstructions: parseExtraInstructions(generation),
            }),
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

      await generationFileRepository.replaceForGeneration(
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
      // stepProposals → 脚本库 draft：只入库待审，不激活（激活需真实用例验证通过）。
      // 失败不影响生成主流程，只记日志。
      if (workflow.state.stepProposals.length > 0) {
        try {
          const proposals = await proposeScriptDrafts({
            repository: scriptRepository,
            proposals: workflow.state.stepProposals,
            existingPatterns: registry.stepPatterns,
            createdBy: null,
          });

          options.logger?.info(
            { generationId: generation.id, ...proposals },
            'script library drafts created from step proposals',
          );
        } catch (error) {
          options.logger?.warn({ err: error }, 'script draft creation failed');
        }
      }

      // workflow.stats 会覆盖 statsJson；额外需求说明只存在 stats 里，必须带上，
      // 否则 pending 状态下前端拿不到它（审批后也不便于追溯本次需求）。
      const extraInstructions = parseExtraInstructions(generation);

      await generationRepository.update(
        generation.id,
        {
          status: 'awaiting_approval',
          approvalStatus: 'pending',
          featurePointsJson: JSON.stringify(workflow.state.featurePoints),
          statsJson: JSON.stringify({ ...workflow.stats, extraInstructions }),
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
      await generationRepository.update(
        generation.id,
        {
          status: 'failed',
          errorJson: JSON.stringify({ reason: safeError(error) }),
          finishedAt: clock(),
        },
        clock(),
      );
      await auditWriter.append({
        tenantId,
        action: AUDIT_ACTION.GENERATION_FAIL,
        resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
        resourceId: generation.id,
        detail: { reason: safeError(error) },
      });

      throw error;
    } finally {
      // 清理失败不能覆盖主流程的异常；两步各自兜底，避免前一步失败导致后一步被跳过。
      if (worktreePath !== undefined && productMirrorPath !== undefined) {
        try {
          await removeWorktree(productMirrorPath, worktreePath);
        } catch (error) {
          options.logger?.warn({ err: error }, 'generation worktree cleanup failed');
        }
      }

      if (suite !== undefined) {
        try {
          await suite.dispose();
        } catch (error) {
          options.logger?.warn({ err: error }, 'generation suite cleanup failed');
        }
      }
    }
  };
}

/** 未知 mode 回退为 range，保持兼容旧数据。 */
function resolveMode(mode: string): GenerationMode {
  return (GENERATION_MODES as readonly string[]).includes(mode)
    ? (mode as GenerationMode)
    : 'range';
}

/** 颗粒度从 stats.granularity（或 stats.meta.granularity）读取，缺省 medium。 */
function resolveGranularity(generation: Generation): GenerationGranularity {
  const stats = parseParams(generation.statsJson);
  const meta =
    stats.meta !== null && typeof stats.meta === 'object'
      ? (stats.meta as Record<string, unknown>)
      : {};

  return parseGranularity(stats.granularity ?? meta.granularity);
}

/**
 * 读取 suite 的 fixtures/*.yaml|json，展平成 design 阶段可引用的变量清单。
 * 失败只记日志：夹具清单是辅助信息，不能阻断生成。
 */
async function loadFixtureVariables(
  suite: SuiteRepository,
): Promise<{ name: string; value: string }[]> {
  try {
    const files = (await suite.listCaseBundleFiles()).filter(
      (file) => file.path.startsWith('fixtures/') && /\.(ya?ml|json)$/i.test(file.path),
    );
    const variables: Record<string, unknown> = {};

    for (const file of files) {
      const document = parseFixtureDocument(file.content, file.path);

      for (const [key, value] of Object.entries(document.variables)) {
        variables[key] = value;
      }
    }

    return flattenFixtureVariables(variables);
  } catch {
    return [];
  }
}

/**
 * 读取租户自定义的阶段提示词（空内容 = 用内置默认）。
 * 与 API 端 PromptTemplateService.resolveOverrides 保持同一语义。
 */
async function resolvePromptOverrides(db: AppDatabase, tenantId: string): Promise<PromptOverrides> {
  const saved = await new PromptTemplateRepository(db, tenantId).list();
  const overrides: PromptOverrides = {};

  for (const entry of saved) {
    const content = entry.content.trim();

    if (content.length === 0) {
      continue;
    }

    overrides[entry.stage] = { system: content };
  }

  return overrides;
}

function parseExtraInstructions(generation: Generation): string {
  const stats = parseParams(generation.statsJson);

  return typeof stats.extraInstructions === 'string' ? stats.extraInstructions.trim() : '';
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
