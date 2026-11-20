// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { JOB_TYPE_NOOP } from '@gait/shared';
import { JobQueue } from '@gait/db';
import type { Job } from '@gait/db';
import { DuplicateJobHandlerError, JobHandlerRegistry } from '../src/job-handler.js';
import { noopJobHandler } from '../src/noop-handler.js';
import { JobWorker } from '../src/worker.js';
import type { WorkerLogger } from '../src/worker.js';

const WORKER_ID = 'worker-test-1';
const databases: TestDatabase[] = [];

function createSilentLogger(): WorkerLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createQueue(): { database: TestDatabase; queue: JobQueue } {
  const database = createTestDatabase();
  databases.push(database);

  return { database, queue: new JobQueue(database.db) };
}

function createWorker(
  queue: JobQueue,
  handlers: JobHandlerRegistry,
  options: {
    clock?: () => number;
    pollIntervalMs?: number;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
): JobWorker {
  return new JobWorker({
    queue,
    handlers,
    logger: createSilentLogger(),
    workerId: WORKER_ID,
    ...options,
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe('JobHandlerRegistry', () => {
  it('registers handlers and rejects duplicates', () => {
    const registry = new JobHandlerRegistry();
    const handler = (): void => {};

    expect(registry.register(JOB_TYPE_NOOP, handler)).toBe(registry);
    expect(registry.resolve(JOB_TYPE_NOOP)).toBe(handler);
    expect(registry.has(JOB_TYPE_NOOP)).toBe(true);
    expect(() => registry.register(JOB_TYPE_NOOP, handler)).toThrow(DuplicateJobHandlerError);
    expect(registry.resolve('missing')).toBeUndefined();
  });

  it('rejects empty job types and non-function handlers', () => {
    const registry = new JobHandlerRegistry();

    expect(() => registry.register('  ', () => {})).toThrow(TypeError);
    expect(() => registry.register(JOB_TYPE_NOOP, null as unknown as () => void)).toThrow(
      TypeError,
    );
  });
});

describe('noopJobHandler', () => {
  it('completes through the worker when the lease is healthy', async () => {
    const { queue } = createQueue();
    const handlers = new JobHandlerRegistry().register(JOB_TYPE_NOOP, noopJobHandler);
    const worker = createWorker(queue, handlers, { clock: () => 1_000 });
    const { job } = queue.enqueue({ type: JOB_TYPE_NOOP, now: 1_000 });

    await worker.runOnce();

    expect(queue.getJob(job.id)?.status).toBe('succeeded');
  });

  it('throws when the lease has already been lost', () => {
    const controller = new AbortController();
    controller.abort(new Error('lease lost'));

    expect(() =>
      noopJobHandler({
        job: { id: 'job-1' } as Job,
        payload: {},
        workerId: WORKER_ID,
        signal: controller.signal,
      }),
    ).toThrow();
  });
});

describe('JobWorker', () => {
  it('claims, executes, and completes a noop job', async () => {
    const { queue } = createQueue();
    const received: Array<{ payload: unknown; jobId: string; workerId: string }> = [];
    const handlers = new JobHandlerRegistry().register(
      JOB_TYPE_NOOP,
      ({ payload, job, workerId }) => {
        received.push({ payload, jobId: job.id, workerId });
      },
    );
    const worker = createWorker(queue, handlers, {
      clock: () => 2_000,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
    });
    const { job } = queue.enqueue({
      type: JOB_TYPE_NOOP,
      payload: { hello: 'world' },
      now: 1_000,
    });

    const processed = await worker.runOnce();

    expect(processed?.id).toBe(job.id);
    expect(received).toEqual([{ payload: { hello: 'world' }, jobId: job.id, workerId: WORKER_ID }]);

    const stored = queue.getJob(job.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.attempts).toBe(1);
    expect(stored?.lockedBy).toBeNull();
    expect(await worker.runOnce()).toBeUndefined();
  });

  it('requeues failed jobs until max attempts are exhausted', async () => {
    const { queue } = createQueue();
    let now = 1_000;
    const handlers = new JobHandlerRegistry().register(JOB_TYPE_NOOP, () => {
      throw new Error('handler exploded');
    });
    const worker = createWorker(queue, handlers, {
      clock: () => now,
      leaseDurationMs: 10_000,
      heartbeatIntervalMs: 1_000,
    });
    const { job } = queue.enqueue({
      type: JOB_TYPE_NOOP,
      maxAttempts: 2,
      now,
    });

    await worker.runOnce();

    const retried = queue.getJob(job.id);
    expect(retried?.status).toBe('queued');
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe('Error: handler exploded');
    expect(retried?.runAfter).toBe(2_000);

    now = 2_000;
    await worker.runOnce();

    const failed = queue.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(2);
    expect(await worker.runOnce()).toBeUndefined();
  });

  it('fails jobs without a registered handler without retrying', async () => {
    const { queue } = createQueue();
    const worker = createWorker(queue, new JobHandlerRegistry(), { clock: () => 1_000 });
    const { job } = queue.enqueue({ type: 'unknown-type', now: 1_000 });

    await worker.runOnce();

    const stored = queue.getJob(job.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toContain('No handler registered');
  });

  it('waits for the in-flight job on graceful stop', async () => {
    const { queue } = createQueue();
    let markStarted: (() => void) | undefined;
    let releaseJob: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    const handlers = new JobHandlerRegistry().register(JOB_TYPE_NOOP, async ({ signal }) => {
      markStarted?.();
      await gate;
      signal.throwIfAborted();
    });
    const worker = createWorker(queue, handlers, {
      pollIntervalMs: 10,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
    });
    const { job } = queue.enqueue({ type: JOB_TYPE_NOOP });
    worker.start();

    await started;

    let stopped = false;
    const stopPromise = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stopped).toBe(false);
    expect(queue.getJob(job.id)?.status).toBe('running');

    releaseJob?.();
    await stopPromise;

    expect(queue.getJob(job.id)?.status).toBe('succeeded');
  });

  it('rejects invalid interval combinations', () => {
    const { queue } = createQueue();
    const handlers = new JobHandlerRegistry();

    expect(
      () =>
        new JobWorker({
          queue,
          handlers,
          logger: createSilentLogger(),
          workerId: WORKER_ID,
          pollIntervalMs: 0,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new JobWorker({
          queue,
          handlers,
          logger: createSilentLogger(),
          workerId: WORKER_ID,
          leaseDurationMs: 1_000,
          heartbeatIntervalMs: 1_000,
        }),
    ).toThrow(RangeError);
  });
});
