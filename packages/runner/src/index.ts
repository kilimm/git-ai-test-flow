import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { GIT_PACKAGE_NAME } from '@gait/git';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export const RUNNER_PACKAGE_NAME = '@gait/runner';

export const RUNNER_UPSTREAM_PACKAGE_NAMES = [
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  GIT_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
