import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export const GIT_PACKAGE_NAME = '@gait/git';

export const GIT_UPSTREAM_PACKAGE_NAMES = [
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
