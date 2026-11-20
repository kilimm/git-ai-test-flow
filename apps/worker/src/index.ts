import { AGENT_PACKAGE_NAME } from '@gait/agent';
import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { DOCS_PACKAGE_NAME } from '@gait/docs';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export const WORKER_APP_NAME = '@gait/worker';

export const WORKER_UPSTREAM_PACKAGE_NAMES = [
  AGENT_PACKAGE_NAME,
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  DOCS_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
