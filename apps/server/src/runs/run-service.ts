// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createS3ClientFromEnv,
  uuidv7,
} from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  ArtifactRepository,
  EnvironmentRepository,
  GenerationRepository,
  JobQueue,
  NotificationRepository,
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunEventRepository,
  RunRepository,
  StepResultRepository,
} from '@gait/db';
import {
  buildRunReport,
  renderReportHtml,
  renderReportJUnit,
  renderReportMarkdown,
} from '@gait/agent';
import type { RunReport } from '@gait/shared';
import type {
  AppDatabase,
  Artifact,
  AuditLogWriter,
  Generation,
  Run,
  RunCase,
  StepResult,
} from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  JOB_TYPE_RUN,
  RUN_ERROR_CODE,
  isTerminalRunStatus,
  normalizeRunSelection,
  runNamespace,
} from '@gait/shared';
import type { RunSelection, RunStatus } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';
import { QuotaService } from '../quotas/quota-service.js';

export interface CreateRunServiceInput {
  environmentId?: string | undefined;
  baselineEnvironmentId?: string | undefined;
  baseSha?: string | undefined;
  headSha: string;
  branch?: string | undefined;
  generationId?: string | undefined;
  selection?:
    | {
        type?: 'all' | 'modules' | 'cases' | 'impact' | undefined;
        modules?: string[] | undefined;
        caseKeys?: string[] | undefined;
      }
    | undefined;
}

export interface RunSummaryView {
  id: string;
  projectId: string;
  environmentId: string | null;
  baselineEnvironmentId: string | null;
  generationId: string | null;
  trigger: string;
  baseSha: string | null;
  headSha: string;
  deployedSha: string | null;
  versionMatch: boolean | null;
  branch: string | null;
  namespace: string;
  status: RunStatus;
  selection: RunSelection;
  stats: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ArtifactView {
  id: string;
  type: string;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  redacted: boolean;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface StepResultView {
  id: string;
  index: number;
  keyword: string;
  text: string;
  type: string;
  status: string;
  durationMs: number | null;
  output: Record<string, unknown>;
  error: Record<string, unknown> | null;
  artifacts: unknown[];
}

export interface RunCaseView {
  id: string;
  featurePath: string;
  scenarioName: string;
  line: number;
  caseKey: string | null;
  tags: string[];
  layer: string | null;
  status: string;
  attempt: number;
  classification: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  evidence: Record<string, unknown>;
  repairStatus: string | null;
  repairs: Array<{
    id: string;
    attemptNo: number;
    repairClass: string;
    rationale: string;
    patchDiff: string | null;
    guardStatus: string;
    reviewStatus: string;
    featurePath: string | null;
    appliedCommit: string | null;
    createdAt: string;
  }>;
  startedAt: string | null;
  finishedAt: string | null;
  steps: StepResultView[];
  artifacts: ArtifactView[];
}

export interface RunDetailView extends RunSummaryView {
  cases: RunCaseView[];
}

export interface RunCreateResult {
  run: RunSummaryView;
  created: boolean;
}

export interface RunServiceOptions {
  db: AppDatabase;
  env: AppEnv;
  auditWriter: AuditLogWriter;
  queue?: JobQueue;
  quotaService?: QuotaService;
  now?: () => number;
}

export interface NotificationView {
  id: string;
  projectId: string;
  runId: string;
  channelId: string | null;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  sentAt: string | null;
  createdAt: string;
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (json === null || json === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function selectionFromJson(json: string): RunSelection {
  const raw = parseObject(json);
  const type = raw.type === 'modules' || raw.type === 'cases' ? raw.type : 'all';
  const modules = Array.isArray(raw.modules)
    ? raw.modules.filter((item): item is string => typeof item === 'string')
    : [];
  const caseKeys = Array.isArray(raw.caseKeys)
    ? raw.caseKeys.filter((item): item is string => typeof item === 'string')
    : [];

  return normalizeRunSelection({ type, modules, caseKeys });
}

/** Run 创建/查询/取消；执行由 Worker 的 Graph B 完成。 */
export class RunService {
  private readonly db: AppDatabase;
  private readonly env: AppEnv;
  private readonly auditWriter: AuditLogWriter;
  private readonly queue: JobQueue;
  private readonly quota: QuotaService;
  private readonly now: () => number;

  constructor(options: RunServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.auditWriter = options.auditWriter;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.now = options.now ?? (() => Date.now());
    this.quota =
      options.quotaService ??
      new QuotaService({
        db: options.db,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
  }

  private runs(context: AuthContext): RunRepository {
    return new RunRepository(this.db, context.tenant.id);
  }

  private projects(context: AuthContext): ProjectRepository {
    return new ProjectRepository(this.db, context.tenant.id);
  }

  private environmentRepository(context: AuthContext): EnvironmentRepository {
    return new EnvironmentRepository(this.db, context.tenant.id);
  }

  private summaryView(run: Run): RunSummaryView {
    return {
      id: run.id,
      projectId: run.projectId,
      environmentId: run.environmentId,
      baselineEnvironmentId: run.baselineEnvironmentId,
      generationId: run.generationId,
      trigger: run.trigger,
      baseSha: run.baseSha,
      headSha: run.headSha,
      deployedSha: run.deployedSha,
      versionMatch: run.versionMatch,
      branch: run.branch,
      namespace: runNamespace(run.id),
      status: run.status,
      selection: selectionFromJson(run.selectionJson),
      stats: parseObject(run.statsJson),
      error: run.errorJson === null ? null : parseObject(run.errorJson),
      createdAt: new Date(run.createdAt).toISOString(),
      startedAt: toIso(run.startedAt),
      finishedAt: toIso(run.finishedAt),
    };
  }

  private artifactView(artifact: Artifact): ArtifactView {
    return {
      id: artifact.id,
      type: artifact.type,
      path: artifact.path,
      mime: artifact.mime,
      size: artifact.size,
      sha256: artifact.sha256,
      redacted: artifact.redacted,
      expiresAt: toIso(artifact.expiresAt),
      metadata: parseObject(artifact.metadataJson),
    };
  }

  private stepView(step: StepResult): StepResultView {
    return {
      id: step.id,
      index: step.stepIndex,
      keyword: step.keyword,
      text: step.text,
      type: step.type,
      status: step.status,
      durationMs: step.durationMs,
      output: parseObject(step.outputJson),
      error: step.errorJson === null ? null : parseObject(step.errorJson),
      artifacts: parseArray<unknown>(step.artifactsJson),
    };
  }

  private caseView(
    runCase: RunCase,
    artifacts: Artifact[],
    steps: StepResult[],
    repairs: ReturnType<RepairAttemptRepository['listByRunCase']> = [],
  ): RunCaseView {
    return {
      id: runCase.id,
      featurePath: runCase.featurePath,
      scenarioName: runCase.scenarioName,
      line: runCase.line,
      caseKey: runCase.caseKey,
      tags: parseArray<string>(runCase.tagsJson),
      layer: runCase.layer,
      status: runCase.status,
      attempt: runCase.attempt,
      classification: runCase.classification,
      durationMs: runCase.durationMs,
      errorMessage: runCase.errorMessage,
      evidence: parseObject(runCase.evidenceJson),
      repairStatus: runCase.repairStatus,
      repairs: repairs.map((repair) => ({
        id: repair.id,
        attemptNo: repair.attemptNo,
        repairClass: repair.repairClass,
        rationale: repair.rationale,
        patchDiff: repair.patchDiff,
        guardStatus: repair.guardStatus,
        reviewStatus: repair.reviewStatus,
        featurePath: repair.featurePath,
        appliedCommit: repair.appliedCommit,
        createdAt: new Date(repair.createdAt).toISOString(),
      })),
      startedAt: toIso(runCase.startedAt),
      finishedAt: toIso(runCase.finishedAt),
      steps: steps.map((step) => this.stepView(step)),
      artifacts: artifacts.map((artifact) => this.artifactView(artifact)),
    };
  }

  private detailView(context: AuthContext, run: Run): RunDetailView {
    const caseRepository = new RunCaseRepository(this.db, context.tenant.id);
    const stepRepository = new StepResultRepository(this.db, context.tenant.id);
    const artifactRepository = new ArtifactRepository(this.db, context.tenant.id);
    const repairRepository = new RepairAttemptRepository(this.db, context.tenant.id);
    const artifacts = artifactRepository.listByRun(run.id);
    const cases = caseRepository.listByRun(run.id).map((runCase) =>
      this.caseView(
        runCase,
        artifacts.filter((artifact) => artifact.runCaseId === runCase.id),
        stepRepository.listByRunCase(runCase.id),
        repairRepository.listByRunCase(runCase.id),
      ),
    );

    return { ...this.summaryView(run), cases };
  }

  private requireRun(context: AuthContext, runId: string): Run {
    const run = this.runs(context).findById(runId);

    if (run === undefined) {
      throw new NotFoundError('Run not found');
    }

    return run;
  }

  private requireGeneration(
    context: AuthContext,
    projectId: string,
    generationId: string,
  ): Generation {
    const generation = new GenerationRepository(this.db, context.tenant.id).findById(generationId);

    if (generation === undefined || generation.projectId !== projectId) {
      throw new NotFoundError('Generation not found');
    }

    return generation;
  }

  private selectionHash(
    selection: RunSelection,
    environmentId: string,
    baselineEnvironmentId: string | null,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({ selection, environmentId, baselineEnvironmentId }), 'utf8')
      .digest('hex')
      .slice(0, 20);
  }

  create(context: AuthContext, projectId: string, input: CreateRunServiceInput): RunCreateResult {
    const project = requireProject(this.projects(context), projectId);
    const environments = this.environmentRepository(context);
    const environment =
      input.environmentId === undefined
        ? (environments.listByProject(project.id).find((item) => item.isDefault) ??
          environments.listByProject(project.id)[0])
        : environments.findById(input.environmentId);

    if (environment === undefined || environment.projectId !== project.id) {
      throw new ValidationError('Run environment is not configured for this project');
    }

    if (input.generationId !== undefined) {
      this.requireGeneration(context, project.id, input.generationId);
    }

    let baselineEnvironmentId: string | null = null;

    if (input.baselineEnvironmentId !== undefined) {
      const baseline = environments.findById(input.baselineEnvironmentId);

      if (baseline === undefined || baseline.projectId !== project.id) {
        throw new ValidationError('Baseline environment is not configured for this project');
      }

      if (baseline.id === environment.id) {
        throw new ValidationError('Baseline environment must differ from the run environment');
      }

      baselineEnvironmentId = baseline.id;
    }

    const selection = normalizeRunSelection(input.selection);

    if (selection.type === 'modules' && selection.modules.length === 0) {
      throw new ValidationError('modules selection must not be empty');
    }

    if (selection.type === 'cases' && selection.caseKeys.length === 0) {
      throw new ValidationError('cases selection must not be empty');
    }

    const repository = this.runs(context);
    const key = `${project.id}:${input.headSha}:${this.selectionHash(
      selection,
      environment.id,
      baselineEnvironmentId,
    )}`;
    const existing = repository.findByProjectAndIdempotencyKey(project.id, key);

    if (existing !== undefined) {
      return { run: this.summaryView(existing), created: false };
    }

    this.quota.assertRunAllowed(context);
    const now = this.now();
    const run = repository.create({
      id: uuidv7(now),
      projectId: project.id,
      environmentId: environment.id,
      baselineEnvironmentId,
      generationId: input.generationId ?? null,
      trigger: 'manual',
      baseSha: input.baseSha ?? null,
      headSha: input.headSha,
      branch: input.branch ?? project.defaultBranch,
      selection,
      status: 'queued',
      idempotencyKey: key,
      createdByUserId: context.user.id,
      now,
    });

    this.queue.enqueue({
      type: JOB_TYPE_RUN,
      payload: { runId: run.id },
      tenantId: context.tenant.id,
      priority: 20,
      dedupeKey: `run:${run.id}`,
      maxAttempts: 2,
      now,
    });

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.RUN_CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.RUN,
      resourceId: run.id,
      detail: {
        projectId: project.id,
        environmentId: environment.id,
        baselineEnvironmentId,
        baseSha: input.baseSha ?? null,
        headSha: input.headSha,
        selection,
      },
      now,
    });

    return { run: this.summaryView(run), created: true };
  }

  list(context: AuthContext, projectId: string): RunSummaryView[] {
    requireProject(this.projects(context), projectId);

    return this.runs(context)
      .listByProject(projectId)
      .map((run) => this.summaryView(run));
  }

  get(context: AuthContext, runId: string): RunDetailView {
    return this.detailView(context, this.requireRun(context, runId));
  }

  cancel(context: AuthContext, runId: string): RunDetailView {
    const run = this.requireRun(context, runId);

    if (isTerminalRunStatus(run.status)) {
      throw new ConflictError('Run is already finished');
    }

    const updated = this.runs(context).update(
      run.id,
      {
        status: 'canceled',
        errorJson: JSON.stringify({
          code: RUN_ERROR_CODE.RUN_CANCELED,
          message: 'Canceled by user',
        }),
        finishedAt: this.now(),
      },
      this.now(),
    );

    if (updated === undefined) {
      throw new NotFoundError('Run not found');
    }

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.RUN_CANCEL,
      resourceType: AUDIT_RESOURCE_TYPE.RUN,
      resourceId: run.id,
      detail: { status: run.status },
      now: this.now(),
    });

    return this.detailView(context, updated);
  }

  /** 报告按需生成：模板保证字段稳定，不依赖报告产物是否已落盘。 */
  report(context: AuthContext, runId: string): RunReport {
    const run = this.requireRun(context, runId);

    return buildRunReport({
      db: this.db,
      tenantId: context.tenant.id,
      runId: run.id,
      baseUrl: this.env.PUBLIC_BASE_URL,
      now: this.now,
    });
  }

  renderReport(
    report: RunReport,
    format: 'json' | 'markdown' | 'html' | 'junit',
  ): { body: string; contentType: string; extension: string } {
    if (format === 'markdown') {
      return {
        body: renderReportMarkdown(report),
        contentType: 'text/markdown; charset=utf-8',
        extension: 'md',
      };
    }

    if (format === 'html') {
      return {
        body: renderReportHtml(report),
        contentType: 'text/html; charset=utf-8',
        extension: 'html',
      };
    }

    if (format === 'junit') {
      return {
        body: renderReportJUnit(report),
        contentType: 'application/xml; charset=utf-8',
        extension: 'xml',
      };
    }

    return {
      body: JSON.stringify({ report }, null, 2),
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
    };
  }

  /** SSE 轮询：先校验 Run 归属，再按 seq 续传事件。 */
  events(
    context: AuthContext,
    runId: string,
    sinceSeq = 0,
  ): {
    run: RunSummaryView;
    events: Array<{ seq: number; type: string; payload: unknown; createdAt: number }>;
    terminal: boolean;
    lastSeq: number;
  } {
    const run = this.requireRun(context, runId);
    const events = new RunEventRepository(this.db, context.tenant.id).listByRun(run.id, sinceSeq);

    return {
      run: this.summaryView(run),
      events: events.map((event) => ({
        seq: event.seq,
        type: event.type,
        payload: parseObject(event.payloadJson),
        createdAt: event.createdAt,
      })),
      terminal: isTerminalRunStatus(run.status),
      lastSeq: events.length === 0 ? sinceSeq : (events[events.length - 1]?.seq ?? sinceSeq),
    };
  }

  notifications(
    context: AuthContext,
    query: { runId?: string | undefined; projectId?: string | undefined },
  ): NotificationView[] {
    const repository = new NotificationRepository(this.db, context.tenant.id);

    if (query.runId !== undefined) {
      const run = this.requireRun(context, query.runId);

      if (query.projectId !== undefined && query.projectId !== run.projectId) {
        throw new NotFoundError('Run not found');
      }

      return repository
        .listByRun(run.id)
        .map((notification) => this.notificationView(notification));
    }

    const projectId = query.projectId as string;

    requireProject(this.projects(context), projectId);

    return repository
      .listByProject(projectId)
      .map((notification) => this.notificationView(notification));
  }

  /** 产物下载：数据库只存相对路径，必须再次校验落在 DATA_DIR/artifacts 内。 */
  async artifact(
    context: AuthContext,
    runId: string,
    artifactId: string,
  ): Promise<{ body: Buffer; mime: string; filename: string }> {
    const run = this.requireRun(context, runId);
    const artifact = new ArtifactRepository(this.db, context.tenant.id).findById(artifactId);

    if (artifact === undefined || artifact.runId !== run.id) {
      throw new NotFoundError('Artifact not found');
    }

    const root = resolve(this.env.DATA_DIR, 'artifacts');
    const absolute = resolve(this.env.DATA_DIR, artifact.path);

    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new NotFoundError('Artifact not found');
    }

    if (existsSync(absolute)) {
      return {
        body: readFileSync(absolute),
        mime: artifact.mime,
        filename: basename(artifact.path).replace(/[^A-Za-z0-9._-]/g, '_'),
      };
    }

    if (artifact.storage === 's3') {
      const s3Key = parseObject(artifact.metadataJson).s3Key;
      const s3 = createS3ClientFromEnv(this.env);

      if (s3 !== null && typeof s3Key === 'string' && s3Key.length > 0) {
        const object = await s3.getObject(s3Key);

        if (object !== null) {
          return {
            body: object.body,
            mime: artifact.mime,
            filename: basename(s3Key).replace(/[^A-Za-z0-9._-]/g, '_'),
          };
        }
      }
    }

    throw new NotFoundError('Artifact file is no longer available');
  }

  private notificationView(notification: {
    id: string;
    projectId: string;
    runId: string;
    channelId: string | null;
    eventType: string;
    status: string;
    attempts: number;
    responseStatus: number | null;
    sentAt: number | null;
    createdAt: number;
  }): NotificationView {
    return {
      id: notification.id,
      projectId: notification.projectId,
      runId: notification.runId,
      channelId: notification.channelId,
      eventType: notification.eventType,
      status: notification.status,
      attempts: notification.attempts,
      responseStatus: notification.responseStatus,
      sentAt: toIso(notification.sentAt),
      createdAt: new Date(notification.createdAt).toISOString(),
    };
  }
}
