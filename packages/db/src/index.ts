import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export const DB_PACKAGE_NAME = '@gait/db';

export const DB_UPSTREAM_PACKAGE_NAMES = [CONFIG_PACKAGE_NAME, SHARED_PACKAGE_NAME] as const;

export * from './client.js';
export * from './migrate.js';
export * from './repository.js';
export * from './schema.js';
