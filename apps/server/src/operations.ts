// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs } from '@gait/config';
import {
  JobQueue,
  WorkerHeartbeatRepository,
  checkDatabaseWritable,
  collectDatabaseMetrics,
} from '@gait/db';
import type { AppDatabase } from '@gait/db';

export interface ReadinessCheck {
  name: string;
  status: 'ok' | 'failed';
  message: string;
}

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: ReadinessCheck[];
  checkedAt: string;
}

export interface MetricsResult {
  generatedAt: string;
  uptimeMs: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  queue: {
    total: number;
    byStatus: Record<string, number>;
    oldestQueuedAgeMs: number | null;
  };
  runs: Record<string, number>;
  classifications: Record<string, number>;
  workers: number;
  latestWorkerSeenAt: string | null;
}

export interface OperationsServiceOptions {
  db: AppDatabase;
  workerStaleMs?: number;
  now?: () => number;
}

/**
 * 运维只读视图：
 * - /readyz 检查数据库可写、队列可查询、Worker 心跳未过期；
 * - /metrics 输出队列、Run、归因与进程内存，供 Prometheus 风格抓取。
 */
export class OperationsService {
  private readonly db: AppDatabase;
  private readonly workerStaleMs: number;
  private readonly now: () => number;

  constructor(options: OperationsServiceOptions) {
    this.db = options.db;
    this.workerStaleMs = options.workerStaleMs ?? 60_000;
    this.now = options.now ?? (() => nowMs());
  }

  readiness(): ReadinessResult {
    const checks: ReadinessCheck[] = [];
    const now = this.now();

    try {
      checkDatabaseWritable(this.db);
      checks.push({ name: 'database', status: 'ok', message: 'Database is writable' });
    } catch (error) {
      checks.push({
        name: 'database',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      new JobQueue(this.db).stats(now);
      checks.push({ name: 'queue', status: 'ok', message: 'Queue is readable' });
    } catch (error) {
      checks.push({
        name: 'queue',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const latest = new WorkerHeartbeatRepository(this.db).latest();

      if (latest === undefined || now - latest.lastSeenAt > this.workerStaleMs) {
        checks.push({
          name: 'worker',
          status: 'failed',
          message:
            latest === undefined
              ? 'No worker heartbeat has been recorded'
              : `Last worker heartbeat is stale (${now - latest.lastSeenAt}ms ago)`,
        });
      } else {
        checks.push({
          name: 'worker',
          status: 'ok',
          message: 'Worker heartbeat is fresh',
        });
      }
    } catch (error) {
      checks.push({
        name: 'worker',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      status: checks.every((check) => check.status === 'ok') ? 'ready' : 'not_ready',
      checks,
      checkedAt: new Date(now).toISOString(),
    };
  }

  metrics(): MetricsResult {
    const now = this.now();
    const queue = new JobQueue(this.db).stats(now);
    const databaseMetrics = collectDatabaseMetrics(this.db);
    const workers = new WorkerHeartbeatRepository(this.db).listSince(now - this.workerStaleMs);
    const memory = process.memoryUsage();

    return {
      generatedAt: new Date(now).toISOString(),
      uptimeMs: Math.round(process.uptime() * 1_000),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
      queue: {
        total: queue.total,
        byStatus: queue.byStatus,
        oldestQueuedAgeMs: queue.oldestQueuedAgeMs,
      },
      runs: databaseMetrics.runs,
      classifications: databaseMetrics.classifications,
      workers: workers.length,
      latestWorkerSeenAt:
        workers[0] === undefined ? null : new Date(workers[0].lastSeenAt).toISOString(),
    };
  }
}
