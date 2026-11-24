// 本文件所有改动要求遵循 agent-rules 规范
import { createLogger, loadDotEnv, loadEnv } from '@gait/config';
import {
  JobQueue,
  RunnerNodeRepository,
  ScriptLibraryRepository,
  TenantRepository,
  WorkerHeartbeatRepository,
  maskDatabaseUrl,
  openDatabase,
} from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { seedScriptLibrary } from '@gait/runner';
import {
  JOB_TYPE_DOC_SYNC,
  JOB_TYPE_GENERATION,
  JOB_TYPE_MODULE_SCAN,
  JOB_TYPE_NOOP,
  JOB_TYPE_RUN,
} from '@gait/shared';
import { openCheckpointStore } from './checkpoint.js';
import type { CheckpointStore } from './checkpoint.js';
import { assertSeparateDatabases } from './config.js';
import { createGenerationJobHandler } from './generation-handler.js';
import { createModuleScanJobHandler } from './module-scan-handler.js';
import { JobHandlerRegistry } from './job-handler.js';
import { noopJobHandler } from './noop-handler.js';
import { createDocJobHandler } from './doc-handler.js';
import { createRunJobHandler } from './run-handler.js';
import { TriggerScheduler } from './trigger-scheduler.js';
import { createWorkerShutdown } from './shutdown.js';
import { createWorkerId, JobWorker } from './worker.js';

loadDotEnv();

async function main(): Promise<void> {
  const env = loadEnv();
  assertSeparateDatabases(env.DATABASE_URL, env.CHECKPOINT_DATABASE_URL);

  const logger = createLogger({ level: env.LOG_LEVEL, name: 'gait-worker' });
  const database = openDatabase({
    url: env.DATABASE_URL,
    onPoolError: (error) => logger.error({ err: error }, 'database pool error'),
  });
  let checkpoint: CheckpointStore;

  try {
    checkpoint = await openCheckpointStore(env.CHECKPOINT_DATABASE_URL, {
      onPoolError: (error) => logger.error({ err: error }, 'checkpoint pool error'),
    });
  } catch (error) {
    await database.close();
    throw error;
  }

  const handlers = new JobHandlerRegistry()
    .register(JOB_TYPE_NOOP, noopJobHandler)
    .register(JOB_TYPE_GENERATION, createGenerationJobHandler({ db: database.db, env, logger }))
    .register(JOB_TYPE_MODULE_SCAN, createModuleScanJobHandler({ db: database.db, env, logger }))
    .register(
      JOB_TYPE_RUN,
      createRunJobHandler({ db: database.db, env, logger, checkpointer: checkpoint.saver }),
    )
    .register(JOB_TYPE_DOC_SYNC, createDocJobHandler({ db: database.db, env, logger }));
  const workerId = createWorkerId();
  const worker = new JobWorker({
    queue: new JobQueue(database.db),
    handlers,
    logger,
    workerId,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseDurationMs: env.WORKER_LEASE_MS,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_MS,
    heartbeatRepository: new WorkerHeartbeatRepository(database.db),
    runnerNodeRepository: new RunnerNodeRepository(database.db),
    ...(env.RUNNER_NAME === undefined ? {} : { runnerName: env.RUNNER_NAME }),
    runnerVersion: process.env.npm_package_version ?? '0.2.0',
  });
  const shutdown = createWorkerShutdown({ worker, checkpoint, database, logger });
  const scheduler = new TriggerScheduler({ db: database.db, logger });

  const handleSignal = (signal: NodeJS.Signals): void => {
    scheduler.stop();
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
  scheduler.start();

  // 启动时补种租户脚本库（幂等）：worker 不跑迁移，只保证内置 step 存在。
  void seedAllTenants(database.db, logger);
  logger.info(
    {
      workerId,
      databaseUrl: maskDatabaseUrl(env.DATABASE_URL),
      checkpointDatabaseUrl: maskDatabaseUrl(env.CHECKPOINT_DATABASE_URL),
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      leaseDurationMs: env.WORKER_LEASE_MS,
      runnerName: env.RUNNER_NAME ?? null,
      runnerMode: env.RUNNER_MODE,
    },
    'worker started',
  );
}

/** 启动期补种内置 step；失败仅记日志。 */
async function seedAllTenants(
  db: AppDatabase,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const tenants = await new TenantRepository(db).listAll();

    for (const tenant of tenants) {
      const plan = await seedScriptLibrary(new ScriptLibraryRepository(db, tenant.id));

      if (plan.created > 0 || plan.updated > 0) {
        logger.info({ tenantId: tenant.id, ...plan }, 'script library seeded');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'script library seeding failed');
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Worker failed to start: ${message}\n`);
  process.exitCode = 1;
});
