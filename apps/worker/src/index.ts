import { AGENT_PACKAGE_NAME } from '@gait/agent';
import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { DOCS_PACKAGE_NAME } from '@gait/docs';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export { CHECKPOINT_PROBE_THREAD_ID, openCheckpointStore } from './checkpoint.js';
export type { CheckpointStore } from './checkpoint.js';
export { assertSeparateDatabasePaths } from './config.js';
export { createGenerationJobHandler } from './generation-handler.js';
export type { GenerationHandlerOptions } from './generation-handler.js';
export { DuplicateJobHandlerError, JobHandlerRegistry } from './job-handler.js';
export type { JobExecutionContext, JobHandler } from './job-handler.js';
export { noopJobHandler } from './noop-handler.js';
export { createWorkerShutdown } from './shutdown.js';
export type { WorkerShutdownHandler, WorkerShutdownResources } from './shutdown.js';
export {
  createWorkerId,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_WORKER_LEASE_MS,
  DEFAULT_WORKER_POLL_INTERVAL_MS,
  JobWorker,
} from './worker.js';
export type { JobWorkerOptions, WorkerLogger } from './worker.js';

export const WORKER_APP_NAME = '@gait/worker';

export const WORKER_UPSTREAM_PACKAGE_NAMES = [
  AGENT_PACKAGE_NAME,
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  DOCS_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
