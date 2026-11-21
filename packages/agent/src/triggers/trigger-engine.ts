// 本文件所有改动要求符合 agent-rules 规范
import { createHash } from 'node:crypto';
import { EnvironmentRepository, GenerationRepository, JobQueue, RunRepository } from '@gait/db';
import type { AppDatabase, Environment, Project, TriggerConfig } from '@gait/db';
import {
  JOB_TYPE_GENERATION,
  JOB_TYPE_RUN,
  normalizeRunSelection,
  nextCronTime,
} from '@gait/shared';
import type { RunSelection, TriggerType } from '@gait/shared';

export interface TriggerFireResult {
  kind: 'run' | 'generation' | 'skipped';
  id: string | null;
  created: boolean;
  reason: string | null;
}

export interface TriggerEngineOptions {
  db: AppDatabase;
  queue?: JobQueue;
  now?: () => number;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function selectionFrom(json: string): RunSelection {
  const raw = parseObject(json);

  return normalizeRunSelection({
    type: typeof raw.type === 'string' ? raw.type : 'all',
    modules: Array.isArray(raw.modules)
      ? raw.modules.filter((item): item is string => typeof item === 'string')
      : [],
    caseKeys: Array.isArray(raw.caseKeys)
      ? raw.caseKeys.filter((item): item is string => typeof item === 'string')
      : [],
  });
}

function selectionHash(selection: RunSelection, environmentId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ selection, environmentId }), 'utf8')
    .digest('hex')
    .slice(0, 20);
}

function triggerLabel(type: TriggerType): string {
  return type === 'git_webhook' ? 'webhook' : type;
}

/**
 * Webhook/部署回调/定时触发器共用执行逻辑：
 * - action=generate：创建 current/range 生成任务；
 * - action=run：直接创建 Run（base 取上一次 Run 的 head，用于影响面选测）；
 * - 相同 head + selection + environment 幂等返回已有记录。
 */
export class TriggerEngine {
  private readonly db: AppDatabase;
  private readonly queue: JobQueue;
  private readonly now: () => number;

  constructor(options: TriggerEngineOptions) {
    this.db = options.db;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.now = options.now ?? (() => Date.now());
  }

  resolveEnvironment(trigger: TriggerConfig, projectId: string): Environment | undefined {
    const repository = new EnvironmentRepository(this.db, trigger.tenantId);
    const environments = repository.listByProject(projectId);

    if (trigger.environmentId !== null) {
      const selected = repository.findById(trigger.environmentId);

      return selected?.projectId === projectId ? selected : undefined;
    }

    return environments.find((environment) => environment.isDefault) ?? environments[0];
  }

  fire(input: {
    trigger: TriggerConfig;
    project: Project;
    headSha?: string | null;
    baseSha?: string | null;
    actorUserId?: string | null;
  }): TriggerFireResult {
    const { trigger, project } = input;
    const selection = selectionFrom(trigger.selectionJson);
    const now = this.now();

    if (trigger.action === 'generate') {
      const headSha = input.headSha ?? 'HEAD';
      const key = `${project.id}:${headSha}:${JSON.stringify(selection)}:trigger:${trigger.id}`;
      const repository = new GenerationRepository(this.db, trigger.tenantId);
      const existing = repository.findByProjectAndIdempotencyKey(project.id, key);

      if (existing !== undefined) {
        return { kind: 'generation', id: existing.id, created: false, reason: null };
      }

      const generation = repository.create({
        projectId: project.id,
        baseSha: input.baseSha ?? null,
        headSha,
        branch: trigger.branch ?? project.defaultBranch,
        mode: input.baseSha === undefined || input.baseSha === null ? 'current' : 'range',
        trigger: triggerLabel(trigger.type),
        idempotencyKey: key,
        createdByUserId: input.actorUserId ?? null,
        now,
      });

      this.queue.enqueue({
        type: JOB_TYPE_GENERATION,
        payload: { generationId: generation.id },
        tenantId: trigger.tenantId,
        priority: 15,
        dedupeKey: `generation:${generation.id}`,
        now,
      });

      return { kind: 'generation', id: generation.id, created: true, reason: null };
    }

    const environment = this.resolveEnvironment(trigger, project.id);

    if (environment === undefined) {
      return { kind: 'skipped', id: null, created: false, reason: 'No environment configured' };
    }

    const headSha = input.headSha ?? environment.deployedSha;

    if (headSha === null || headSha === undefined) {
      return {
        kind: 'skipped',
        id: null,
        created: false,
        reason: 'Environment has no deployed SHA',
      };
    }

    const previousRuns = new RunRepository(this.db, trigger.tenantId).listByProject(project.id, 1);
    const baseSha = input.baseSha ?? previousRuns[0]?.headSha ?? null;
    const effectiveSelection =
      selection.type === 'impact' && baseSha === null
        ? normalizeRunSelection({ type: 'all' })
        : selection;
    const key = `${project.id}:${headSha}:${selectionHash(effectiveSelection, environment.id)}`;
    const repository = new RunRepository(this.db, trigger.tenantId);
    const existing = repository.findByProjectAndIdempotencyKey(project.id, key);

    if (existing !== undefined) {
      return { kind: 'run', id: existing.id, created: false, reason: null };
    }

    const run = repository.create({
      projectId: project.id,
      environmentId: environment.id,
      trigger: triggerLabel(trigger.type),
      baseSha,
      headSha,
      branch: trigger.branch ?? project.defaultBranch,
      selection: effectiveSelection,
      idempotencyKey: key,
      createdByUserId: input.actorUserId ?? null,
      now,
    });

    this.queue.enqueue({
      type: JOB_TYPE_RUN,
      payload: { runId: run.id },
      tenantId: trigger.tenantId,
      priority: trigger.type === 'schedule' ? 10 : 25,
      dedupeKey: `run:${run.id}`,
      maxAttempts: 2,
      now,
    });

    return { kind: 'run', id: run.id, created: true, reason: null };
  }

  nextRunAt(cron: string | null, from = new Date(this.now())): number | null {
    if (cron === null) {
      return null;
    }

    const next = nextCronTime(cron, from);

    return next === null ? null : next.getTime();
  }
}
