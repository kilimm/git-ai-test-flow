import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { GIT_PACKAGE_NAME } from '@gait/git';
import { RUNNER_PACKAGE_NAME } from '@gait/runner';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export const AGENT_PACKAGE_NAME = '@gait/agent';

export const AGENT_UPSTREAM_PACKAGE_NAMES = [
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  GIT_PACKAGE_NAME,
  RUNNER_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
