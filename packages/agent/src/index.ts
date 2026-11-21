import { CONFIG_PACKAGE_NAME } from '@gait/config';
import { DB_PACKAGE_NAME } from '@gait/db';
import { GIT_PACKAGE_NAME } from '@gait/git';
import { RUNNER_PACKAGE_NAME } from '@gait/runner';
import { SHARED_PACKAGE_NAME } from '@gait/shared';

export * from './attribution/analyze.js';
export * from './attribution/evidence.js';
export * from './attribution/llm-attribution.js';
export * from './attribution/repair-guard.js';
export * from './attribution/repair-proposal.js';
export * from './attribution/rules.js';
export * from './generation/cases.js';
export * from './generation/commit.js';
export * from './generation/prompts.js';
export * from './generation/types.js';
export * from './generation/workflow.js';
export * from './llm/llm-client.js';
export * from './notify/feishu.js';
export * from './notify/notifier.js';
export * from './report/report-builder.js';
export * from './run/workflow.js';
export * from './triggers/trigger-engine.js';

export const AGENT_PACKAGE_NAME = '@gait/agent';

export const AGENT_UPSTREAM_PACKAGE_NAMES = [
  CONFIG_PACKAGE_NAME,
  DB_PACKAGE_NAME,
  GIT_PACKAGE_NAME,
  RUNNER_PACKAGE_NAME,
  SHARED_PACKAGE_NAME,
] as const;
