// 本文件所有改动要求遵循 agent-rules 规范
import type { OpenedDatabase } from '@gait/db';
import type { CheckpointStore } from './checkpoint.js';
import type { JobWorker, WorkerLogger } from './worker.js';

export interface WorkerShutdownResources {
  worker: Pick<JobWorker, 'stop'>;
  checkpoint: Pick<CheckpointStore, 'close'>;
  database: Pick<OpenedDatabase, 'close'>;
  logger: WorkerLogger;
}

export type WorkerShutdownHandler = (signal: NodeJS.Signals) => Promise<void>;

/**
 * 幂等优雅退出：先停止领取并等待当前任务，再关闭 checkpoint 库与业务库。
 * 多次收到信号时复用同一个 Promise，避免重复关闭资源。
 */
export function createWorkerShutdown(resources: WorkerShutdownResources): WorkerShutdownHandler {
  let shutdownPromise: Promise<void> | undefined;

  return (signal) => {
    shutdownPromise ??= (async () => {
      resources.logger.info({ signal }, 'worker shutting down');

      try {
        await resources.worker.stop();
      } finally {
        try {
          await resources.checkpoint.close();
        } finally {
          await resources.database.close();
        }
      }

      resources.logger.info({ signal }, 'worker shutdown complete');
    })().catch((error: unknown) => {
      resources.logger.error({ err: error, signal }, 'worker shutdown failed');
      throw error;
    });

    return shutdownPromise;
  };
}
