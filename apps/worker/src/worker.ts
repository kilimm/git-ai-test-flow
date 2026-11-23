// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs, uuidv7 } from '@gait/config';
import type { Job, JobQueue, RunnerNodeRepository, WorkerHeartbeatRepository } from '@gait/db';
import type { JobHandlerRegistry } from './job-handler.js';

export const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_WORKER_LEASE_MS = 30_000;
export const DEFAULT_WORKER_HEARTBEAT_MS = 10_000;

export interface WorkerLogger {
  debug(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface JobWorkerOptions {
  queue: JobQueue;
  handlers: JobHandlerRegistry;
  logger: WorkerLogger;
  workerId?: string;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatRepository?: WorkerHeartbeatRepository;
  runnerNodeRepository?: RunnerNodeRepository;
  runnerName?: string;
  runnerVersion?: string;
  clock?: () => number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function createWorkerId(): string {
  return `worker-${uuidv7()}`;
}

/**
 * 单并发 Worker。一次只处理一个任务，任务执行期间按固定间隔续租；
 * stop() 停止领取新任务并等待当前任务结束，避免优雅退出时半途中断。
 */
export class JobWorker {
  private readonly queue: JobQueue;
  private readonly handlers: JobHandlerRegistry;
  private readonly logger: WorkerLogger;
  private readonly workerIdValue: string;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatRepository: WorkerHeartbeatRepository | undefined;
  private readonly runnerNodeRepository: RunnerNodeRepository | undefined;
  private readonly runnerName: string | undefined;
  private readonly runnerVersion: string | undefined;
  private readonly clock: () => number;

  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private tickPromise: Promise<void> | undefined;

  constructor(options: JobWorkerOptions) {
    this.queue = options.queue;
    this.handlers = options.handlers;
    this.logger = options.logger;
    this.workerIdValue = options.workerId ?? createWorkerId();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_WORKER_LEASE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_MS;
    this.heartbeatRepository = options.heartbeatRepository;
    this.runnerNodeRepository = options.runnerNodeRepository;
    this.runnerName = options.runnerName;
    this.runnerVersion = options.runnerVersion;
    this.clock = options.clock ?? nowMs;

    assertPositiveInteger(this.pollIntervalMs, 'pollIntervalMs');
    assertPositiveInteger(this.leaseDurationMs, 'leaseDurationMs');
    assertPositiveInteger(this.heartbeatIntervalMs, 'heartbeatIntervalMs');

    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new RangeError('heartbeatIntervalMs must be less than leaseDurationMs');
    }
  }

  get workerId(): string {
    return this.workerIdValue;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    // 启动心跳不阻塞轮询调度；失败已在 recordHeartbeat 内部记录为警告。
    void this.recordHeartbeat('idle');
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.started = false;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const pendingTick = this.tickPromise;

    if (pendingTick !== undefined) {
      await pendingTick;
    }
  }

  /** 供测试或单次任务脚本使用：领取并处理一个任务，不启动轮询。 */
  async runOnce(): Promise<Job | undefined> {
    const job = await this.claimNextJob();

    if (job === undefined) {
      return undefined;
    }

    await this.executeJob(job);
    return job;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.started) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      const tickPromise = this.tick().finally(() => {
        if (this.tickPromise === tickPromise) {
          this.tickPromise = undefined;
        }

        this.scheduleNext(this.pollIntervalMs);
      });

      this.tickPromise = tickPromise;
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const reclaimed = await this.queue.reclaimExpiredJobs(this.clock());

      if (reclaimed.requeued + reclaimed.failed > 0) {
        this.logger.warn({ ...reclaimed }, 'reclaimed expired jobs');
      }

      const job = await this.claimNextJob();

      if (job !== undefined) {
        await this.executeJob(job);
      } else {
        await this.recordHeartbeat('idle');
      }
    } catch (error) {
      await this.recordHeartbeat('error');
      this.logger.error({ err: error }, 'worker poll failed');
    }
  }

  private async recordHeartbeat(
    status: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.heartbeatRepository?.record({
        workerId: this.workerIdValue,
        status,
        details,
        now: this.clock(),
      });
    } catch (error) {
      // 心跳失败不应阻断任务处理；/readyz 会因心跳过期而报警。
      this.logger.warn({ err: error }, 'worker heartbeat write failed');
    }

    if (this.runnerNodeRepository !== undefined && this.runnerName !== undefined) {
      try {
        await this.runnerNodeRepository.heartbeat(
          this.runnerName,
          {
            ...(this.runnerVersion === undefined ? {} : { version: this.runnerVersion }),
          },
          this.clock(),
        );
      } catch (error) {
        this.logger.warn({ err: error }, 'runner node heartbeat failed');
      }
    }
  }

  private async claimNextJob(): Promise<Job | undefined> {
    return this.queue.claimNextJob({
      workerId: this.workerIdValue,
      leaseDurationMs: this.leaseDurationMs,
      now: this.clock(),
    });
  }

  private async executeJob(job: Job): Promise<void> {
    const handler = this.handlers.resolve(job.type);

    if (handler === undefined) {
      const status = await this.queue.failJob({
        job,
        workerId: this.workerIdValue,
        error: new Error(`No handler registered for job type: ${job.type}`),
        retryable: false,
        now: this.clock(),
      });

      this.logger.error({ jobId: job.id, jobType: job.type, status }, 'job has no handler');
      return;
    }

    const controller = new AbortController();
    const heartbeatTimer = setInterval(() => {
      void this.renewLease(job, controller);
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const startedAt = this.clock();
    await this.recordHeartbeat('busy', { jobId: job.id, jobType: job.type });

    try {
      const payload = JSON.parse(job.payloadJson) as unknown;
      await handler({
        job,
        payload,
        workerId: this.workerIdValue,
        signal: controller.signal,
      });

      const completed = await this.queue.completeJob({
        jobId: job.id,
        workerId: this.workerIdValue,
        now: this.clock(),
      });

      if (completed) {
        this.logger.info(
          {
            jobId: job.id,
            jobType: job.type,
            attempts: job.attempts,
            durationMs: Math.max(0, this.clock() - startedAt),
          },
          'job succeeded',
        );
      } else {
        this.logger.warn({ jobId: job.id, jobType: job.type }, 'job finished after lease loss');
      }
    } catch (error) {
      const status = await this.queue.failJob({
        job,
        workerId: this.workerIdValue,
        error,
        now: this.clock(),
      });

      this.logger.error({ err: error, jobId: job.id, jobType: job.type, status }, 'job failed');
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async renewLease(job: Job, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) {
      return;
    }

    try {
      const renewed = await this.queue.heartbeatJob({
        jobId: job.id,
        workerId: this.workerIdValue,
        leaseDurationMs: this.leaseDurationMs,
        now: this.clock(),
      });

      if (!renewed) {
        this.logger.warn({ jobId: job.id, jobType: job.type }, 'job lease lost');
        controller.abort(new Error('Job lease lost'));
      }
    } catch (error) {
      this.logger.error({ err: error, jobId: job.id }, 'job heartbeat failed');
    }
  }
}
