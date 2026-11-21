// 本文件所有改动要求遵循 agent-rules 规范

/** Run 状态机：queued → preparing → running → analyzing → reporting → 终态。 */
export const RUN_STATUSES = [
  'queued',
  'preparing',
  'running',
  'analyzing',
  'reporting',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  ANALYZING: 'analyzing',
  REPORTING: 'reporting',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const satisfies Record<string, RunStatus>;

/** 终态不可再被 Worker 领取，也不能重复取消。 */
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'canceled'] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const RUN_CASE_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'error',
  'skipped',
  'quarantined',
] as const;

export type RunCaseStatus = (typeof RUN_CASE_STATUSES)[number];

export const RUN_CASE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  ERROR: 'error',
  SKIPPED: 'skipped',
  QUARANTINED: 'quarantined',
} as const satisfies Record<string, RunCaseStatus>;

export const STEP_STATUSES = [
  'pending',
  'running',
  'passed',
  'failed',
  'skipped',
  'error',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  ERROR: 'error',
} as const satisfies Record<string, StepStatus>;

/** 步骤执行类型；ui 由 Playwright 确定性执行，agent 从 M9 起启用。 */
export const STEP_EXECUTION_TYPES = [
  'builtin',
  'template',
  'script',
  'api',
  'db',
  'ui',
  'agent',
  'plugin',
] as const;

export type StepExecutionType = (typeof STEP_EXECUTION_TYPES)[number];

export const CLASSIFICATIONS = ['code_bug', 'test_bug', 'env_issue', 'flaky', 'unknown'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION = {
  CODE_BUG: 'code_bug',
  TEST_BUG: 'test_bug',
  ENV_ISSUE: 'env_issue',
  FLAKY: 'flaky',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, Classification>;

export const ARTIFACT_TYPES = [
  'api_request',
  'api_response',
  'db_snapshot',
  'screenshot',
  'trace',
  'video',
  'console',
  'har',
  'log',
  'report',
  'fixture',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_TYPE = {
  API_REQUEST: 'api_request',
  API_RESPONSE: 'api_response',
  DB_SNAPSHOT: 'db_snapshot',
  SCREENSHOT: 'screenshot',
  TRACE: 'trace',
  VIDEO: 'video',
  CONSOLE: 'console',
  HAR: 'har',
  LOG: 'log',
  REPORT: 'report',
  FIXTURE: 'fixture',
} as const satisfies Record<string, ArtifactType>;

/** 产物保留期（天）；数据库只保存相对路径。 */
export const ARTIFACT_RETENTION_DAYS: Readonly<Record<ArtifactType, number>> = Object.freeze({
  api_request: 180,
  api_response: 180,
  db_snapshot: 180,
  screenshot: 30,
  trace: 14,
  video: 14,
  console: 180,
  har: 30,
  log: 180,
  report: 180,
  fixture: 14,
});

export const RUN_SELECTION_TYPES = ['all', 'modules', 'cases', 'impact'] as const;
export type RunSelectionType = (typeof RUN_SELECTION_TYPES)[number];

export interface RunSelection {
  type: RunSelectionType;
  modules: string[];
  caseKeys: string[];
}

export const DEFAULT_RUN_SELECTION: RunSelection = Object.freeze({
  type: 'all',
  modules: [],
  caseKeys: [],
});

/** 归一化选择条件；去重、去空白并限制数量。 */
export function normalizeRunSelection(input?: {
  type?: string | undefined;
  modules?: readonly string[] | undefined;
  caseKeys?: readonly string[] | undefined;
}): RunSelection {
  const type: RunSelectionType =
    input?.type === 'modules' || input?.type === 'cases' || input?.type === 'impact'
      ? input.type
      : 'all';
  const modules = [...new Set((input?.modules ?? []).map((item) => item.trim()).filter(Boolean))];
  const caseKeys = [...new Set((input?.caseKeys ?? []).map((item) => item.trim()).filter(Boolean))];

  return { type, modules: modules.slice(0, 100), caseKeys: caseKeys.slice(0, 500) };
}

/** 模块与场景筛选；tags 同时包含 feature 与 scenario 标签。 */
export function selectionMatches(
  selection: RunSelection,
  tags: readonly string[],
  caseKey: string | null,
  impactModules: readonly string[] = [],
): boolean {
  if (selection.type === 'all') {
    return true;
  }

  if (selection.type === 'cases') {
    return caseKey !== null && selection.caseKeys.includes(caseKey);
  }

  const modules = tags
    .filter((tag) => tag.startsWith('module:'))
    .map((tag) => tag.slice('module:'.length));
  const selected = selection.type === 'impact' ? impactModules : selection.modules;

  return modules.some((module) => selected.includes(module));
}

export const RUN_ERROR_CODE = {
  ENV_UNHEALTHY: 'ENV_UNHEALTHY',
  ENV_VERSION_MISMATCH: 'ENV_VERSION_MISMATCH',
  NO_CASES_FOUND: 'NO_CASES_FOUND',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  RUN_CANCELED: 'RUN_CANCELED',
  WORKSPACE_QUOTA_EXCEEDED: 'WORKSPACE_QUOTA_EXCEEDED',
  WORKSPACE_FAILED: 'WORKSPACE_FAILED',
  DB_NOT_CONFIGURED: 'DB_NOT_CONFIGURED',
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',
  FIXTURE_FAILED: 'FIXTURE_FAILED',
  STEP_FAILED: 'STEP_FAILED',
  AGENT_UNSUPPORTED: 'AGENT_UNSUPPORTED',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  REPORT_FAILED: 'REPORT_FAILED',
  NOTIFICATION_FAILED: 'NOTIFICATION_FAILED',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  REPAIR_FAILED: 'REPAIR_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

export type RunErrorCode = (typeof RUN_ERROR_CODE)[keyof typeof RUN_ERROR_CODE];

/** 规范 12.8 的默认值；环境配置可覆盖并发与单用例超时。 */
export const RUN_LIMITS = Object.freeze({
  DEFAULT_CASE_TIMEOUT_MS: 60_000,
  UI_CASE_TIMEOUT_MS: 120_000,
  AGENT_STEP_TIMEOUT_MS: 45_000,
  HEALTHCHECK_TIMEOUT_MS: 60_000,
  RUN_TIMEOUT_MS: 30 * 60_000,
  API_CONCURRENCY: 3,
  UI_CONCURRENCY: 1,
  MAX_API_CONCURRENCY: 8,
  MAX_UI_CONCURRENCY: 2,
  MAX_CASES_PER_RUN: 500,
  MAX_STEPS_PER_CASE: 50,
  /** 失败用例自动重跑次数（M6）。 */
  RERUN_MAX_ATTEMPTS: 1,
  MAX_RESPONSE_BYTES: 2 * 1024 * 1024,
  DEFAULT_WORKSPACE_MAX_BYTES: 2 * 1024 * 1024 * 1024,
  CANCEL_POLL_INTERVAL_MS: 500,
  SCRIPT_TIMEOUT_MS: 30_000,
  DEFAULT_HTTP_RETRIES: 0,
  MAX_HTTP_RETRIES: 2,
});

/** 生成唯一测试数据命名空间：run_<runId 前 8 位>_。 */
export function runNamespace(runId: string): string {
  const compact = runId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase();

  return `run_${compact.length > 0 ? compact : 'unknown'}_`;
}

export interface RunStats {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  canceled: number;
  /** 重跑通过（偶发失败）的用例数。 */
  flaky: number;
  /** 被隔离的用例数。 */
  quarantined: number;
  /** 按归因分类统计；未归因用例不计入。 */
  classifications: Record<Classification, number>;
  analysis?: {
    analyzedAt: number;
    rule: number;
    llm: number;
    fallback: number;
    llmInputTokens: number;
    llmOutputTokens: number;
  };
  durationMs: number;
  concurrency: { api: number; ui: number };
}

export function emptyClassificationCounts(): Record<Classification, number> {
  return { code_bug: 0, test_bug: 0, env_issue: 0, flaky: 0, unknown: 0 };
}

export function emptyRunStats(): RunStats {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    error: 0,
    skipped: 0,
    canceled: 0,
    flaky: 0,
    quarantined: 0,
    classifications: emptyClassificationCounts(),
    durationMs: 0,
    concurrency: { api: RUN_LIMITS.API_CONCURRENCY, ui: RUN_LIMITS.UI_CONCURRENCY },
  };
}
