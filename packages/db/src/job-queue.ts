// 本文件所有改动要求遵循 agent-rules 规范
import { and, asc, count, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import { JOB_STATUS } from '@gait/shared';
import type { JobStatus } from '@gait/shared';
import type { AppDatabase } from './client.js';
import { DEFAULT_JOB_MAX_ATTEMPTS, jobs } from './schema.js';
import type { Job } from './schema.js';

export const DEFAULT_JOB_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_JOB_RETRY_MAX_DELAY_MS = 60_000;
export const JOB_LEASE_EXPIRED_ERROR = 'Job lease expired';

const MAX_LAST_ERROR_LENGTH = 2_000;

export interface EnqueueJobInput {
  type: string;
  payload?: unknown;
  tenantId?: string | null;
  priority?: number;
  runAfter?: number;
  maxAttempts?: number;
  dedupeKey?: string;
  now?: number;
}

export interface EnqueueJobResult {
  job: Job;
  created: boolean;
}

export interface ClaimJobOptions {
  workerId: string;
  leaseDurationMs: number;
  now?: number;
}

export interface HeartbeatJobOptions {
  jobId: string;
  workerId: string;
  leaseDurationMs: number;
  now?: number;
}

export interface CompleteJobOptions {
  jobId: string;
  workerId: string;
  now?: number;
}

export interface FailJobOptions {
  job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>;
  workerId: string;
  error: unknown;
  retryable?: boolean;
  now?: number;
}

export interface ReclaimResult {
  requeued: number;
  failed: number;
}

export interface JobQueueStats {
  byStatus: Record<string, number>;
  total: number;
  oldestQueuedAgeMs: number | null;
}

export interface JobQueueOptions {
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function toErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'Unknown error');

  return message.slice(0, MAX_LAST_ERROR_LENGTH);
}

/**
 * PostgreSQL 任务队列。领取在事务内先 `SELECT ... FOR UPDATE SKIP LOCKED` 再更新，
 * 多 Worker 并发时不会重复领取同一任务；崩溃恢复由过期租约回收完成。
 */
export class JobQueue {
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    private readonly db: AppDatabase,
    options: JobQueueOptions = {},
  ) {
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_JOB_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_JOB_RETRY_MAX_DELAY_MS;

    assertPositiveInteger(this.retryBaseDelayMs, 'retryBaseDelayMs');
    assertPositiveInteger(this.retryMaxDelayMs, 'retryMaxDelayMs');

    if (this.retryBaseDelayMs > this.retryMaxDelayMs) {
      throw new RangeError('retryBaseDelayMs must not exceed retryMaxDelayMs');
    }
  }

  async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    return this.enqueueOn(this.db, input);
  }

  /** 在调用方事务内入队，保证业务记录与 job 同时提交或回滚。 */
  async enqueueOn(db: AppDatabase, input: EnqueueJobInput): Promise<EnqueueJobResult> {
    assertNonEmptyString(input.type, 'type');

    const now = input.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const runAfter = input.runAfter ?? now;
    const priority = input.priority ?? 0;
    const maxAttempts = input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;

    assertNonNegativeInteger(runAfter, 'runAfter');
    assertNonNegativeInteger(priority, 'priority');
    assertPositiveInteger(maxAttempts, 'maxAttempts');

    const dedupeKey = input.dedupeKey ?? null;
    const payloadJson = JSON.stringify(input.payload ?? {}) ?? '{}';
    const id = uuidv7(now);

    const [inserted] = await db
      .insert(jobs)
      .values({
        id,
        tenantId: input.tenantId ?? null,
        type: input.type,
        payloadJson,
        priority,
        runAfter,
        maxAttempts,
        dedupeKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted !== undefined) {
      return { job: inserted, created: true };
    }

    if (dedupeKey !== null) {
      const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);

      if (existing !== undefined) {
        return { job: existing, created: false };
      }
    }

    throw new Error(`Failed to enqueue job (id=${id})`);
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);

    return row;
  }

  async claimNextJob(options: ClaimJobOptions): Promise<Job | undefined> {
    assertNonEmptyString(options.workerId, 'workerId');
    assertPositiveInteger(options.leaseDurationMs, 'leaseDurationMs');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const leaseExpiresAt = now + options.leaseDurationMs;

    return this.db.transaction(async (tx) => {
      // SKIP LOCKED 保证多个 Worker 并发领取时各自拿到不同的行。
      const [candidate] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, JOB_STATUS.QUEUED), lte(jobs.runAfter, now)))
        .orderBy(desc(jobs.priority), asc(jobs.runAfter), asc(jobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (candidate === undefined) {
        return undefined;
      }

      const [updated] = await tx
        .update(jobs)
        .set({
          status: JOB_STATUS.RUNNING,
          attempts: sql`${jobs.attempts} + 1`,
          lockedBy: options.workerId,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(eq(jobs.id, candidate.id))
        .returning();

      return updated;
    });
  }

  async heartbeatJob(options: HeartbeatJobOptions): Promise<boolean> {
    assertNonEmptyString(options.jobId, 'jobId');
    assertNonEmptyString(options.workerId, 'workerId');
    assertPositiveInteger(options.leaseDurationMs, 'leaseDurationMs');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const updated = await this.db
      .update(jobs)
      .set({
        leaseExpiresAt: now + options.leaseDurationMs,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, options.jobId),
          eq(jobs.status, JOB_STATUS.RUNNING),
          eq(jobs.lockedBy, options.workerId),
        ),
      )
      .returning({ id: jobs.id });

    return updated.length > 0;
  }

  async completeJob(options: CompleteJobOptions): Promise<boolean> {
    assertNonEmptyString(options.jobId, 'jobId');
    assertNonEmptyString(options.workerId, 'workerId');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const updated = await this.db
      .update(jobs)
      .set({
        status: JOB_STATUS.SUCCEEDED,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, options.jobId),
          eq(jobs.status, JOB_STATUS.RUNNING),
          eq(jobs.lockedBy, options.workerId),
        ),
      )
      .returning({ id: jobs.id });

    return updated.length > 0;
  }

  /**
   * 失败任务按指数退避重试；超过 max_attempts 或显式不可重试时标记 failed。
   * 返回最终状态；租约已丢失时返回 undefined。
   */
  async failJob(options: FailJobOptions): Promise<JobStatus | undefined> {
    assertNonEmptyString(options.job.id, 'job.id');
    assertNonEmptyString(options.workerId, 'workerId');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const shouldRetry =
      options.retryable !== false && options.job.attempts < options.job.maxAttempts;
    const status = shouldRetry ? JOB_STATUS.QUEUED : JOB_STATUS.FAILED;
    const runAfter = shouldRetry ? now + this.computeRetryDelayMs(options.job.attempts) : null;

    const updated = await this.db
      .update(jobs)
      .set({
        status,
        ...(runAfter === null ? {} : { runAfter }),
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: toErrorMessage(options.error),
        updatedAt: now,
      })
      .where(
        and(
          eq(jobs.id, options.job.id),
          eq(jobs.status, JOB_STATUS.RUNNING),
          eq(jobs.lockedBy, options.workerId),
        ),
      )
      .returning({ id: jobs.id });

    return updated.length > 0 ? status : undefined;
  }

  /**
   * 回收租约过期的 running 任务：未达最大尝试次数则重新排队，
   * 达到上限则标记失败，避免崩溃任务无限重试。
   */
  async reclaimExpiredJobs(now: number = nowMs()): Promise<ReclaimResult> {
    assertNonNegativeInteger(now, 'now');

    return this.db.transaction(async (tx) => {
      const expiredCondition = and(
        eq(jobs.status, JOB_STATUS.RUNNING),
        isNotNull(jobs.leaseExpiresAt),
        lte(jobs.leaseExpiresAt, now),
      );

      const failed = await tx
        .update(jobs)
        .set({
          status: JOB_STATUS.FAILED,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: JOB_LEASE_EXPIRED_ERROR,
          updatedAt: now,
        })
        .where(and(expiredCondition, sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
        .returning({ id: jobs.id });

      const requeued = await tx
        .update(jobs)
        .set({
          status: JOB_STATUS.QUEUED,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(expiredCondition, sql`${jobs.attempts} < ${jobs.maxAttempts}`))
        .returning({ id: jobs.id });

      return { requeued: requeued.length, failed: failed.length };
    });
  }

  computeRetryDelayMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);

    return Math.min(this.retryBaseDelayMs * 2 ** exponent, this.retryMaxDelayMs);
  }

  /** 只读统计，供 /readyz、/metrics 与队列积压告警使用。 */
  async stats(now: number = nowMs()): Promise<JobQueueStats> {
    const rows = await this.db
      .select({ status: jobs.status, value: count() })
      .from(jobs)
      .groupBy(jobs.status);
    const byStatus: Record<string, number> = {};

    for (const row of rows) {
      byStatus[row.status] = row.value;
    }

    const [oldest] = await this.db
      .select({ createdAt: jobs.createdAt })
      .from(jobs)
      .where(eq(jobs.status, JOB_STATUS.QUEUED))
      .orderBy(asc(jobs.createdAt))
      .limit(1);

    return {
      byStatus,
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      oldestQueuedAgeMs: oldest === undefined ? null : Math.max(0, now - oldest.createdAt),
    };
  }
}
