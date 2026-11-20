// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_LEASE_EXPIRED_ERROR, JobQueue } from '../src/job-queue.js';
import { jobs } from '../src/schema.js';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';

const WORKER_ID = 'worker-test-1';
const JOB_TYPE = 'noop';
const databases: TestDatabase[] = [];

function createQueue(): { database: TestDatabase; queue: JobQueue } {
  const database = createTestDatabase();
  databases.push(database);

  return { database, queue: new JobQueue(database.db) };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe('JobQueue', () => {
  it('enqueues a job and deduplicates by dedupeKey', () => {
    const { database, queue } = createQueue();
    const first = queue.enqueue({
      type: JOB_TYPE,
      payload: { value: 1 },
      dedupeKey: 'dedupe-1',
      now: 1_000,
    });

    expect(first.created).toBe(true);
    expect(first.job.status).toBe('queued');
    expect(first.job.attempts).toBe(0);
    expect(first.job.maxAttempts).toBe(3);
    expect(first.job.runAfter).toBe(1_000);
    expect(first.job.payloadJson).toBe('{"value":1}');

    const duplicate = queue.enqueue({
      type: JOB_TYPE,
      payload: { value: 2 },
      dedupeKey: 'dedupe-1',
      now: 2_000,
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(duplicate.job.payloadJson).toBe('{"value":1}');
    expect(database.db.select().from(jobs).all()).toHaveLength(1);
  });

  it('claims the highest-priority eligible job and skips future jobs', () => {
    const { queue } = createQueue();
    const low = queue.enqueue({
      type: JOB_TYPE,
      priority: 1,
      runAfter: 1_000,
      now: 1_000,
    });
    const high = queue.enqueue({
      type: JOB_TYPE,
      priority: 10,
      runAfter: 1_000,
      now: 1_000,
    });
    queue.enqueue({
      type: JOB_TYPE,
      priority: 100,
      runAfter: 5_000,
      now: 1_000,
    });

    const first = queue.claimNextJob({
      workerId: WORKER_ID,
      leaseDurationMs: 1_000,
      now: 1_000,
    });

    expect(first?.id).toBe(high.job.id);
    expect(first?.status).toBe('running');
    expect(first?.attempts).toBe(1);
    expect(first?.lockedBy).toBe(WORKER_ID);
    expect(first?.leaseExpiresAt).toBe(2_000);

    const second = queue.claimNextJob({
      workerId: WORKER_ID,
      leaseDurationMs: 1_000,
      now: 1_000,
    });

    expect(second?.id).toBe(low.job.id);
    expect(
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 1_000, now: 4_999 }),
    ).toBeUndefined();
    expect(
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 1_000, now: 5_000 })?.type,
    ).toBe(JOB_TYPE);
  });

  it('renews leases only for the owning worker', () => {
    const { queue } = createQueue();
    const { job } = queue.enqueue({ type: JOB_TYPE, now: 1_000 });
    queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 500, now: 1_000 });

    expect(
      queue.heartbeatJob({
        jobId: job.id,
        workerId: 'other-worker',
        leaseDurationMs: 500,
        now: 1_200,
      }),
    ).toBe(false);

    expect(
      queue.heartbeatJob({
        jobId: job.id,
        workerId: WORKER_ID,
        leaseDurationMs: 500,
        now: 1_200,
      }),
    ).toBe(true);
    expect(queue.getJob(job.id)?.leaseExpiresAt).toBe(1_700);

    expect(queue.completeJob({ jobId: job.id, workerId: 'other-worker', now: 1_200 })).toBe(false);
    expect(queue.completeJob({ jobId: job.id, workerId: WORKER_ID, now: 1_200 })).toBe(true);

    const completed = queue.getJob(job.id);
    expect(completed?.status).toBe('succeeded');
    expect(completed?.lockedBy).toBeNull();
    expect(completed?.leaseExpiresAt).toBeNull();
    expect(queue.completeJob({ jobId: job.id, workerId: WORKER_ID, now: 1_300 })).toBe(false);
  });

  it('retries with exponential backoff and fails after max attempts', () => {
    const { queue } = createQueue();
    const { job } = queue.enqueue({
      type: JOB_TYPE,
      maxAttempts: 2,
      now: 1_000,
    });

    const firstAttempt = queue.claimNextJob({
      workerId: WORKER_ID,
      leaseDurationMs: 10_000,
      now: 1_000,
    });

    expect(firstAttempt?.attempts).toBe(1);
    expect(
      queue.failJob({
        job: firstAttempt!,
        workerId: WORKER_ID,
        error: new Error('boom'),
        now: 1_000,
      }),
    ).toBe('queued');

    const retried = queue.getJob(job.id);
    expect(retried?.status).toBe('queued');
    expect(retried?.runAfter).toBe(2_000);
    expect(retried?.lastError).toBe('Error: boom');
    expect(retried?.lockedBy).toBeNull();
    expect(
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 1_000, now: 1_999 }),
    ).toBeUndefined();

    const secondAttempt = queue.claimNextJob({
      workerId: WORKER_ID,
      leaseDurationMs: 10_000,
      now: 2_000,
    });

    expect(secondAttempt?.attempts).toBe(2);
    expect(
      queue.failJob({
        job: secondAttempt!,
        workerId: WORKER_ID,
        error: new Error('still broken'),
        now: 2_000,
      }),
    ).toBe('failed');

    const failed = queue.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lockedBy).toBeNull();
    expect(failed?.leaseExpiresAt).toBeNull();
    expect(
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 1_000, now: 3_000 }),
    ).toBeUndefined();
  });

  it('reclaims expired leases and stops retrying at max attempts', () => {
    const { queue } = createQueue();
    const { job } = queue.enqueue({
      type: JOB_TYPE,
      maxAttempts: 2,
      now: 1_000,
    });

    queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 100, now: 1_000 });
    expect(
      queue.claimNextJob({ workerId: 'other-worker', leaseDurationMs: 100, now: 1_100 }),
    ).toBeUndefined();
    expect(queue.reclaimExpiredJobs(1_100)).toEqual({ requeued: 1, failed: 0 });

    const requeued = queue.getJob(job.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempts).toBe(1);
    expect(requeued?.lockedBy).toBeNull();
    expect(requeued?.leaseExpiresAt).toBeNull();

    queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 100, now: 1_100 });
    expect(queue.reclaimExpiredJobs(1_200)).toEqual({ requeued: 0, failed: 1 });

    const failed = queue.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(2);
    expect(failed?.lastError).toBe(JOB_LEASE_EXPIRED_ERROR);
    expect(
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 100, now: 1_300 }),
    ).toBeUndefined();
  });

  it('caps exponential retry delays', () => {
    const { database } = createQueue();
    const queue = new JobQueue(database.db, {
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 250,
    });

    expect(queue.computeRetryDelayMs(1)).toBe(100);
    expect(queue.computeRetryDelayMs(2)).toBe(200);
    expect(queue.computeRetryDelayMs(3)).toBe(250);
    expect(queue.computeRetryDelayMs(10)).toBe(250);
  });

  it('rejects invalid enqueue and lease values', () => {
    const { queue } = createQueue();

    expect(() => queue.enqueue({ type: '   ' })).toThrow(TypeError);
    expect(() => queue.enqueue({ type: JOB_TYPE, maxAttempts: 0 })).toThrow(RangeError);
    expect(() =>
      queue.claimNextJob({ workerId: WORKER_ID, leaseDurationMs: 0, now: 1_000 }),
    ).toThrow(RangeError);
  });
});
