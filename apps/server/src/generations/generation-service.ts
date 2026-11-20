// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from '@gait/config';
import type { ProblemIssue } from '@gait/config';
import {
  CredentialRepository,
  FeatureIndexRepository,
  GenerationFileRepository,
  GenerationRepository,
  JobQueue,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, AuditLogWriter, Generation, GenerationFile, Project } from '@gait/db';
import type { SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  JOB_TYPE_GENERATION,
} from '@gait/shared';
import type { FeaturePoint, GenerationStatus, ApprovalStatus } from '@gait/shared';
import { PROMPT_VERSION, buildGenerationCommitMessage, commitGeneration } from '@gait/agent';
import type { CommitGenerationResult } from '@gait/agent';
import { SuiteRepository } from '@gait/git';
import { StepRegistry, parseSuiteStepCatalog, validateFeatureDrafts } from '@gait/runner';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface CreateGenerationServiceInput {
  mode: 'current' | 'range';
  baseSha?: string | undefined;
  headSha?: string | undefined;
  branch?: string | undefined;
  selection?: { modules: string[] } | undefined;
}

export interface ApproveGenerationInput {
  message?: string | undefined;
}

export interface RejectGenerationInput {
  reason?: string | undefined;
}

export interface GenerationSummaryView {
  id: string;
  projectId: string;
  mode: string;
  baseSha: string | null;
  headSha: string;
  branch: string | null;
  trigger: string;
  status: GenerationStatus;
  approvalStatus: ApprovalStatus;
  model: string | null;
  promptVersion: string | null;
  featurePoints: FeaturePoint[];
  stats: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface GenerationFileView {
  id: string;
  path: string;
  action: string;
  content: string;
  contentHash: string;
  scenarioCount: number;
  validationStatus: string;
  validationErrors: unknown[];
  committedSha: string | null;
}

export interface GenerationDetailView extends GenerationSummaryView {
  files: GenerationFileView[];
}

export interface GenerationCreateResult {
  generation: GenerationSummaryView;
  created: boolean;
}

export interface GenerationApproveResult {
  generation: GenerationDetailView;
  commit: {
    commitSha: string;
    changed: boolean;
    committedPaths: string[];
    index: { files: number; scenarios: number; missing: number };
  };
}

export interface GenerationServiceOptions {
  db: AppDatabase;
  env: AppEnv;
  cipher: SecretCipher;
  auditWriter: AuditLogWriter;
  queue?: JobQueue;
  now?: () => number;
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (json === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toProblemIssues(
  issues: readonly { code: string; message: string; path?: string; line?: number }[],
): ProblemIssue[] {
  return issues.map((issue) => ({
    path:
      issue.path === undefined
        ? ''
        : `${issue.path}${issue.line === undefined ? '' : `:${issue.line}`}`,
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * 生成任务编排：
 * - API 只创建记录并投递 Worker 任务；
 * - 审批阶段同步校验并提交 Suite（短操作），不执行 LLM。
 */
export class GenerationService {
  private readonly db: AppDatabase;
  private readonly env: AppEnv;
  private readonly cipher: SecretCipher;
  private readonly auditWriter: AuditLogWriter;
  private readonly queue: JobQueue;
  private readonly now: () => number;

  constructor(options: GenerationServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.cipher = options.cipher;
    this.auditWriter = options.auditWriter;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.now = options.now ?? (() => Date.now());
  }

  private generations(context: AuthContext): GenerationRepository {
    return new GenerationRepository(this.db, context.tenant.id);
  }

  private files(context: AuthContext): GenerationFileRepository {
    return new GenerationFileRepository(this.db, context.tenant.id);
  }

  private projects(context: AuthContext): ProjectRepository {
    return new ProjectRepository(this.db, context.tenant.id);
  }

  private index(context: AuthContext): FeatureIndexRepository {
    return new FeatureIndexRepository(this.db, context.tenant.id);
  }

  private summaryView(generation: Generation): GenerationSummaryView {
    return {
      id: generation.id,
      projectId: generation.projectId,
      mode: generation.mode,
      baseSha: generation.baseSha,
      headSha: generation.headSha,
      branch: generation.branch,
      trigger: generation.trigger,
      status: generation.status,
      approvalStatus: generation.approvalStatus,
      model: generation.model,
      promptVersion: generation.promptVersion,
      featurePoints: parseArray<FeaturePoint>(generation.featurePointsJson),
      stats: parseObject(generation.statsJson) ?? {},
      error: parseObject(generation.errorJson),
      createdAt: toIso(generation.createdAt),
      updatedAt: toIso(generation.updatedAt),
      finishedAt: generation.finishedAt === null ? null : toIso(generation.finishedAt),
    };
  }

  private fileView(file: GenerationFile): GenerationFileView {
    return {
      id: file.id,
      path: file.path,
      action: file.action,
      content: file.content,
      contentHash: file.contentHash,
      scenarioCount: file.scenarioCount,
      validationStatus: file.validationStatus,
      validationErrors: parseArray<unknown>(file.validationErrorsJson),
      committedSha: file.committedSha,
    };
  }

  private detailView(context: AuthContext, generation: Generation): GenerationDetailView {
    return {
      ...this.summaryView(generation),
      files: this.files(context)
        .listByGeneration(generation.id)
        .map((file) => this.fileView(file)),
    };
  }

  private requireGeneration(context: AuthContext, generationId: string): Generation {
    const generation = this.generations(context).findById(generationId);

    if (generation === undefined) {
      throw new NotFoundError('Generation not found');
    }

    return generation;
  }

  private selectionHash(input: CreateGenerationServiceInput): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          mode: input.mode,
          baseSha: input.baseSha ?? null,
          headSha: input.headSha ?? null,
          branch: input.branch ?? null,
          selection: input.selection ?? null,
        }),
        'utf8',
      )
      .digest('hex')
      .slice(0, 20);
  }

  create(
    context: AuthContext,
    projectId: string,
    input: CreateGenerationServiceInput,
  ): GenerationCreateResult {
    const project = requireProject(this.projects(context), projectId);
    const repository = this.generations(context);
    const key = `${project.id}:${input.headSha ?? input.branch ?? 'HEAD'}:${this.selectionHash(input)}`;
    const existing = repository.findByProjectAndIdempotencyKey(project.id, key);

    if (existing !== undefined) {
      return { generation: this.summaryView(existing), created: false };
    }

    const generation = repository.create({
      id: uuidv7(this.now()),
      projectId: project.id,
      baseSha: input.baseSha ?? null,
      headSha: input.headSha ?? input.branch ?? 'HEAD',
      branch: input.branch ?? project.defaultBranch,
      mode: input.mode,
      trigger: 'manual',
      status: 'queued',
      idempotencyKey: key,
      statsJson: JSON.stringify({ selection: input.selection ?? null }),
      promptVersion: PROMPT_VERSION,
      createdByUserId: context.user.id,
      now: this.now(),
    });

    this.queue.enqueue({
      type: JOB_TYPE_GENERATION,
      payload: { generationId: generation.id },
      tenantId: context.tenant.id,
      priority: 10,
      dedupeKey: `generation:${generation.id}`,
      maxAttempts: 2,
      now: this.now(),
    });

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.GENERATION_CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
      resourceId: generation.id,
      detail: {
        projectId: project.id,
        mode: input.mode,
        baseSha: input.baseSha ?? null,
        headSha: input.headSha ?? null,
        selection: input.selection ?? null,
      },
      now: this.now(),
    });

    return { generation: this.summaryView(generation), created: true };
  }

  list(context: AuthContext, projectId: string): GenerationSummaryView[] {
    requireProject(this.projects(context), projectId);

    return this.generations(context)
      .listByProject(projectId)
      .map((generation) => this.summaryView(generation));
  }

  get(context: AuthContext, generationId: string): GenerationDetailView {
    return this.detailView(context, this.requireGeneration(context, generationId));
  }

  private async openSuite(
    context: AuthContext,
    project: Project,
    generation: Generation,
  ): Promise<{ suite: SuiteRepository; registry: StepRegistry; featurePrefix: string }> {
    let auth: { username?: string; token?: string } | null = null;

    if (project.gitCredentialId !== null) {
      const credential = new CredentialRepository(this.db, context.tenant.id).findById(
        project.gitCredentialId,
      );

      if (credential !== undefined && credential.type === CREDENTIAL_TYPE.GIT_PAT) {
        const token = this.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
          ciphertext: credential.secretCiphertext,
          iv: credential.secretIv,
          authTag: credential.secretAuthTag,
          keyVersion: credential.keyVersion,
        });
        auth = {
          ...(credential.username === null ? {} : { username: credential.username }),
          token,
        };
      }
    }

    const suite = await SuiteRepository.open({
      mode: project.suiteMode,
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      suiteRepoUrl: project.suiteRepoUrl,
      suitePath: project.suitePath,
      featureRoot: project.featureRoot,
      dataDir: this.env.DATA_DIR,
      headSha: generation.headSha,
      auth,
    });
    const catalogJson = suite.readFile('steps/registry.json');
    let registry: StepRegistry;

    try {
      registry = StepRegistry.createDefault(parseSuiteStepCatalog(catalogJson));
    } catch (error) {
      await suite.dispose();
      throw new ValidationError(
        error instanceof Error ? error.message : 'Invalid suite step registry',
      );
    }

    return { suite, registry, featurePrefix: suite.featurePrefix };
  }

  private validateGenerationFiles(
    context: AuthContext,
    project: Project,
    files: readonly GenerationFile[],
    registry: StepRegistry,
    featurePrefix: string,
  ): ReturnType<typeof validateFeatureDrafts> {
    const generationPaths = new Set(files.map((file) => file.path));
    const existingFingerprints = new Set(
      this.index(context)
        .listActiveCases(project.id)
        .filter((existing) => !generationPaths.has(existing.featurePath))
        .map((existing) => existing.fingerprint),
    );

    return validateFeatureDrafts({
      drafts: files.map((file) => ({
        path: file.path,
        content: file.content,
        action: file.action === 'obsolete' ? 'obsolete' : 'update',
      })),
      stepRegistry: registry,
      existingFingerprints,
      featurePrefix,
    });
  }

  async editFile(
    context: AuthContext,
    generationId: string,
    fileId: string,
    content: string,
  ): Promise<GenerationDetailView> {
    const generation = this.requireGeneration(context, generationId);

    if (generation.status !== 'awaiting_approval') {
      throw new ConflictError('Generation is not awaiting approval');
    }

    const project = requireProject(this.projects(context), generation.projectId);
    const fileRepository = this.files(context);
    const target = fileRepository.findById(fileId);

    if (target === undefined || target.generationId !== generation.id) {
      throw new NotFoundError('Generation file not found');
    }

    const files = fileRepository
      .listByGeneration(generation.id)
      .map((file) => (file.id === fileId ? { ...file, content } : file));
    const { suite, registry, featurePrefix } = await this.openSuite(context, project, generation);

    try {
      const validation = this.validateGenerationFiles(
        context,
        project,
        files,
        registry,
        featurePrefix,
      );

      if (!validation.valid) {
        throw new ValidationError(
          'Edited feature failed validation',
          toProblemIssues(validation.issues.filter((issue) => issue.severity === 'error')),
        );
      }

      for (const file of files) {
        const validated = validation.files.find((item) => item.path === file.path);
        fileRepository.updateContent(
          file.id,
          {
            content: file.content,
            contentHash: validated?.contentHash ?? file.contentHash,
            scenarioCount: validated?.scenarioCount ?? 0,
            validationStatus: validated?.validationStatus ?? 'invalid',
            validationErrors: validated?.issues ?? [],
          },
          this.now(),
        );
      }

      this.generations(context).update(
        generation.id,
        { status: 'awaiting_approval', approvalStatus: 'edited' },
        this.now(),
      );
    } finally {
      await suite.dispose();
    }

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.GENERATION_EDIT,
      resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
      resourceId: generation.id,
      detail: { fileId, path: target.path },
      now: this.now(),
    });

    return this.get(context, generation.id);
  }

  async approve(
    context: AuthContext,
    generationId: string,
    input: ApproveGenerationInput,
  ): Promise<GenerationApproveResult> {
    const generation = this.requireGeneration(context, generationId);

    if (generation.status !== 'awaiting_approval') {
      throw new ConflictError('Generation is not awaiting approval');
    }

    const project = requireProject(this.projects(context), generation.projectId);
    const fileRepository = this.files(context);
    const files = fileRepository.listByGeneration(generation.id);

    if (files.length === 0) {
      throw new ValidationError('Generation has no proposed files');
    }

    const { suite, registry, featurePrefix } = await this.openSuite(context, project, generation);
    let result: CommitGenerationResult;

    try {
      const validation = this.validateGenerationFiles(
        context,
        project,
        files,
        registry,
        featurePrefix,
      );

      if (!validation.valid) {
        for (const file of files) {
          const validated = validation.files.find((item) => item.path === file.path);
          fileRepository.updateContent(
            file.id,
            {
              validationStatus: validated?.validationStatus ?? 'invalid',
              validationErrors: validated?.issues ?? [],
            },
            this.now(),
          );
        }

        throw new ValidationError(
          'Generation failed validation and cannot be committed',
          toProblemIssues(validation.issues.filter((issue) => issue.severity === 'error')),
        );
      }

      for (const file of files) {
        const validated = validation.files.find((item) => item.path === file.path);
        fileRepository.updateContent(
          file.id,
          {
            scenarioCount: validated?.scenarioCount ?? 0,
            validationStatus: validated?.validationStatus ?? 'valid',
            validationErrors: validated?.issues ?? [],
          },
          this.now(),
        );
      }

      const featurePoints = parseArray<FeaturePoint>(generation.featurePointsJson);
      const message =
        input.message?.trim() ??
        buildGenerationCommitMessage({
          generationId: generation.id,
          headSha: generation.headSha,
          featurePointIds: featurePoints.map((featurePoint) => featurePoint.id),
        });
      result = await commitGeneration({
        suite,
        featureIndex: this.index(context),
        generationRepository: this.generations(context),
        generationFileRepository: fileRepository,
        generationId: generation.id,
        projectId: project.id,
        files: files.map((file) => ({ path: file.path, content: file.content })),
        message,
        now: this.now(),
      });
    } finally {
      await suite.dispose();
    }

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.GENERATION_COMMIT,
      resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
      resourceId: generation.id,
      detail: {
        commitSha: result.commitSha,
        changed: result.changed,
        files: result.committedPaths.length,
      },
      now: this.now(),
    });

    return {
      generation: this.get(context, generation.id),
      commit: {
        commitSha: result.commitSha,
        changed: result.changed,
        committedPaths: result.committedPaths,
        index: result.index,
      },
    };
  }

  reject(
    context: AuthContext,
    generationId: string,
    input: RejectGenerationInput,
  ): GenerationDetailView {
    const generation = this.requireGeneration(context, generationId);

    if (generation.status !== 'awaiting_approval') {
      throw new ConflictError('Generation is not awaiting approval');
    }

    this.generations(context).update(
      generation.id,
      {
        status: 'rejected',
        approvalStatus: 'rejected',
        errorJson: JSON.stringify({ reason: input.reason ?? 'Rejected by user' }),
        finishedAt: this.now(),
      },
      this.now(),
    );
    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.GENERATION_REJECT,
      resourceType: AUDIT_RESOURCE_TYPE.GENERATION,
      resourceId: generation.id,
      detail: { reason: input.reason ?? null },
      now: this.now(),
    });

    return this.get(context, generation.id);
  }
}
