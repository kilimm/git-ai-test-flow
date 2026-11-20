// 本文件所有改动要求遵循 agent-rules 规范
import { eq, sql } from 'drizzle-orm';
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

export interface JobQueueOptions {
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

interface JobRow {
  id: string;
  tenant_id: string | null;
  type: string;
  payload_json: string;
  status: JobStatus;
  priority: number;
  run_after: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  lease_expires_at: number | null;
  dedupe_key: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
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

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    payloadJson: row.payload_json,
    status: row.status,
    priority: row.priority,
    runAfter: row.run_after,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
    dedupeKey: row.dedupe_key,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'Unknown error');

  return message.slice(0, MAX_LAST_ERROR_LENGTH);
}

/**
 * SQLite 任务队列。领取使用单条 `UPDATE ... RETURNING`，利用 SQLite 写锁保证
 * 多 Worker 之间不会重复领取同一任务；崩溃恢复由过期租约回收完成。
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

  enqueue(input: EnqueueJobInput): EnqueueJobResult {
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

    const inserted = this.db
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
      .returning()
      .get();

    if (inserted !== undefined) {
      return { job: inserted, created: true };
    }

    if (dedupeKey !== null) {
      const existing = this.db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).get();

      if (existing !== undefined) {
        return { job: existing, created: false };
      }
    }

    throw new Error(`Failed to enqueue job (id=${id})`);
  }

  getJob(jobId: string): Job | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  }

  claimNextJob(options: ClaimJobOptions): Job | undefined {
    assertNonEmptyString(options.workerId, 'workerId');
    assertPositiveInteger(options.leaseDurationMs, 'leaseDurationMs');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const leaseExpiresAt = now + options.leaseDurationMs;

    const row = this.db.get<JobRow>(sql`
      UPDATE jobs
      SET
        status = ${JOB_STATUS.RUNNING},
        attempts = attempts + 1,
        locked_by = ${options.workerId},
        lease_expires_at = ${leaseExpiresAt},
        updated_at = ${now}
      WHERE id = (
        SELECT id
        FROM jobs
        WHERE status = ${JOB_STATUS.QUEUED}
          AND run_after <= ${now}
        ORDER BY priority DESC, run_after ASC, created_at ASC
        LIMIT 1
      )
      RETURNING
        id,
        tenant_id,
        type,
        payload_json,
        status,
        priority,
        run_after,
        attempts,
        max_attempts,
        locked_by,
        lease_expires_at,
        dedupe_key,
        last_error,
        created_at,
        updated_at
    `);

    return row === undefined ? undefined : toJob(row);
  }

  heartbeatJob(options: HeartbeatJobOptions): boolean {
    assertNonEmptyString(options.jobId, 'jobId');
    assertNonEmptyString(options.workerId, 'workerId');
    assertPositiveInteger(options.leaseDurationMs, 'leaseDurationMs');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const result = this.db.run(sql`
      UPDATE jobs
      SET
        lease_expires_at = ${now + options.leaseDurationMs},
        updated_at = ${now}
      WHERE id = ${options.jobId}
        AND status = ${JOB_STATUS.RUNNING}
        AND locked_by = ${options.workerId}
    `);

    return result.changes > 0;
  }

  completeJob(options: CompleteJobOptions): boolean {
    assertNonEmptyString(options.jobId, 'jobId');
    assertNonEmptyString(options.workerId, 'workerId');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const result = this.db.run(sql`
      UPDATE jobs
      SET
        status = ${JOB_STATUS.SUCCEEDED},
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ${now}
      WHERE id = ${options.jobId}
        AND status = ${JOB_STATUS.RUNNING}
        AND locked_by = ${options.workerId}
    `);

    return result.changes > 0;
  }

  /**
   * 失败任务按指数退避重试；超过 max_attempts 或显式不可重试时标记 failed。
   * 返回最终状态；租约已丢失时返回 undefined。
   */
  failJob(options: FailJobOptions): JobStatus | undefined {
    assertNonEmptyString(options.job.id, 'job.id');
    assertNonEmptyString(options.workerId, 'workerId');

    const now = options.now ?? nowMs();
    assertNonNegativeInteger(now, 'now');

    const shouldRetry =
      options.retryable !== false && options.job.attempts < options.job.maxAttempts;
    const status = shouldRetry ? JOB_STATUS.QUEUED : JOB_STATUS.FAILED;
    const runAfter = shouldRetry ? now + this.computeRetryDelayMs(options.job.attempts) : null;

    const result = this.db.run(sql`
      UPDATE jobs
      SET
        status = ${status},
        run_after = COALESCE(${runAfter}, run_after),
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = ${toErrorMessage(options.error)},
        updated_at = ${now}
      WHERE id = ${options.job.id}
        AND status = ${JOB_STATUS.RUNNING}
        AND locked_by = ${options.workerId}
    `);

    return result.changes > 0 ? status : undefined;
  }

  /**
   * 回收租约过期的 running 任务：未达最大尝试次数则重新排队，
   * 达到上限则标记失败，避免崩溃任务无限重试。
   */
  reclaimExpiredJobs(now: number = nowMs()): ReclaimResult {
    assertNonNegativeInteger(now, 'now');

    return this.db.transaction((tx) => {
      const failed = tx.run(sql`
        UPDATE jobs
        SET
          status = ${JOB_STATUS.FAILED},
          locked_by = NULL,
          lease_expires_at = NULL,
          last_error = ${JOB_LEASE_EXPIRED_ERROR},
          updated_at = ${now}
        WHERE status = ${JOB_STATUS.RUNNING}
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ${now}
          AND attempts >= max_attempts
      `).changes;

      const requeued = tx.run(sql`
        UPDATE jobs
        SET
          status = ${JOB_STATUS.QUEUED},
          locked_by = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
        WHERE status = ${JOB_STATUS.RUNNING}
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ${now}
          AND attempts < max_attempts
      `).changes;

      return { requeued, failed };
    });
  }

  computeRetryDelayMs(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);

    return Math.min(this.retryBaseDelayMs * 2 ** exponent, this.retryMaxDelayMs);
  }
}
