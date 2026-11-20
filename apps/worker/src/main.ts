// 本文件所有改动要求遵循 agent-rules 规范
import { createLogger, loadDotEnv, loadEnv } from '@gait/config';
import { JobQueue, openDatabase } from '@gait/db';
import { JOB_TYPE_GENERATION, JOB_TYPE_NOOP, JOB_TYPE_RUN } from '@gait/shared';
import { openCheckpointStore } from './checkpoint.js';
import type { CheckpointStore } from './checkpoint.js';
import { assertSeparateDatabasePaths } from './config.js';
import { createGenerationJobHandler } from './generation-handler.js';
import { JobHandlerRegistry } from './job-handler.js';
import { noopJobHandler } from './noop-handler.js';
import { createRunJobHandler } from './run-handler.js';
import { createWorkerShutdown } from './shutdown.js';
import { createWorkerId, JobWorker } from './worker.js';

loadDotEnv();

async function main(): Promise<void> {
  const env = loadEnv();
  assertSeparateDatabasePaths(env.DATABASE_PATH, env.CHECKPOINT_DB_PATH);

  const logger = createLogger({ level: env.LOG_LEVEL, name: 'gait-worker' });
  const database = openDatabase({ path: env.DATABASE_PATH });
  let checkpoint: CheckpointStore;

  try {
    checkpoint = await openCheckpointStore(env.CHECKPOINT_DB_PATH);
  } catch (error) {
    database.close();
    throw error;
  }

  const handlers = new JobHandlerRegistry()
    .register(JOB_TYPE_NOOP, noopJobHandler)
    .register(JOB_TYPE_GENERATION, createGenerationJobHandler({ db: database.db, env, logger }))
    .register(
      JOB_TYPE_RUN,
      createRunJobHandler({ db: database.db, env, logger, checkpointer: checkpoint.saver }),
    );
  const workerId = createWorkerId();
  const worker = new JobWorker({
    queue: new JobQueue(database.db),
    handlers,
    logger,
    workerId,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseDurationMs: env.WORKER_LEASE_MS,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_MS,
  });
  const shutdown = createWorkerShutdown({ worker, checkpoint, database, logger });

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  worker.start();
  logger.info(
    {
      workerId,
      databasePath: env.DATABASE_PATH,
      checkpointPath: env.CHECKPOINT_DB_PATH,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      leaseDurationMs: env.WORKER_LEASE_MS,
    },
    'worker started',
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Worker failed to start: ${message}\n`);
  process.exitCode = 1;
});
