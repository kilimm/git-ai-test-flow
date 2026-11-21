// 本文件所有改动要求遵循 agent-rules 规范
import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export * from './builder.js';
export * from './compression.js';
export * from './manifest.js';
export * from './references.js';
export * from './sync.js';

export const DOCS_PACKAGE_NAME = '@gait/docs';

export const DOCS_UPSTREAM_PACKAGE_NAMES = [
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
