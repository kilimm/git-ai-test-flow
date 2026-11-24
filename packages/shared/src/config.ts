// 本文件所有改动要求遵循 agent-rules 规范

/**
 * 项目与配置领域常量，与 PROJECT_SPEC 第 9 章保持一致。
 * 前后端共享枚举与校验函数，避免在 API、GUI 各写一套规则。
 */

export const SUITE_MODES = ['managed', 'external', 'same_repo'] as const;
export type SuiteMode = (typeof SUITE_MODES)[number];

export const SUITE_MODE = {
  MANAGED: 'managed',
  EXTERNAL: 'external',
  SAME_REPO: 'same_repo',
} as const satisfies Record<string, SuiteMode>;

/**
 * 用例存储位置（项目级）：
 * - repo：Git 仓库是事实源，DB 只做索引；
 * - db：数据库是事实源，执行时导出到临时 worktree 供 runner 读取。
 */
export const CASE_STORAGES = ['repo', 'db'] as const;
export type CaseStorage = (typeof CASE_STORAGES)[number];

export const CASE_STORAGE = {
  REPO: 'repo',
  DB: 'db',
} as const satisfies Record<string, CaseStorage>;

export const CREDENTIAL_TYPES = ['git_pat', 'llm_api_key', 'test_account', 'db_password'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const CREDENTIAL_TYPE = {
  GIT_PAT: 'git_pat',
  LLM_API_KEY: 'llm_api_key',
  TEST_ACCOUNT: 'test_account',
  DB_PASSWORD: 'db_password',
} as const satisfies Record<string, CredentialType>;

export const LLM_PURPOSES = ['generation', 'triage', 'docs', 'vision'] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const LLM_PURPOSE = {
  GENERATION: 'generation',
  TRIAGE: 'triage',
  DOCS: 'docs',
  VISION: 'vision',
} as const satisfies Record<string, LlmPurpose>;

export const LLM_PROVIDERS = ['openai-compatible', 'anthropic', 'gemini', 'deepseek'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER = {
  OPENAI_COMPATIBLE: 'openai-compatible',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  DEEPSEEK: 'deepseek',
} as const satisfies Record<string, LlmProvider>;

/** 连通性/健康状态：未检查过为 unknown。 */
export const HEALTH_STATUSES = ['unknown', 'healthy', 'unhealthy'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const HEALTH_STATUS = {
  UNKNOWN: 'unknown',
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
} as const satisfies Record<string, HealthStatus>;

export const VERSION_SOURCES = ['manual', 'header', 'endpoint'] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

export const VERSION_SOURCE = {
  MANUAL: 'manual',
  HEADER: 'header',
  ENDPOINT: 'endpoint',
} as const satisfies Record<string, VersionSource>;

export const DATABASE_TYPES = ['mysql', 'postgresql', 'sqlite'] as const;
export type DatabaseType = (typeof DATABASE_TYPES)[number];

export const DATABASE_TYPE = {
  MYSQL: 'mysql',
  POSTGRESQL: 'postgresql',
  SQLITE: 'sqlite',
} as const satisfies Record<string, DatabaseType>;

export const DATABASE_WRITE_MODES = ['readonly', 'fixtures', 'full'] as const;
export type DatabaseWriteMode = (typeof DATABASE_WRITE_MODES)[number];

export const DATABASE_WRITE_MODE = {
  READONLY: 'readonly',
  FIXTURES: 'fixtures',
  FULL: 'full',
} as const satisfies Record<string, DatabaseWriteMode>;

export const NOTIFICATION_EVENTS = ['run_finished', 'run_failed', 'daily_digest'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT = {
  RUN_FINISHED: 'run_finished',
  RUN_FAILED: 'run_failed',
  DAILY_DIGEST: 'daily_digest',
} as const satisfies Record<string, NotificationEvent>;

export const NOTIFICATION_TEST_STATUSES = ['unknown', 'success', 'failed'] as const;
export type NotificationTestStatus = (typeof NOTIFICATION_TEST_STATUSES)[number];

export const NOTIFICATION_TEST_STATUS = {
  UNKNOWN: 'unknown',
  SUCCESS: 'success',
  FAILED: 'failed',
} as const satisfies Record<string, NotificationTestStatus>;

export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_SLUG_MIN_LENGTH = 2;
export const PROJECT_SLUG_MAX_LENGTH = 40;
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_BRANCH_MAX_LENGTH = 255;
export const REPO_PATH_MAX_LENGTH = 200;

export const DEFAULT_SUITE_PATH = '.ai-test/';
export const DEFAULT_FEATURE_ROOT = 'features/';
export const DEFAULT_DOCS_ROOT = 'docs/ai/';

export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 5_000;
export const DEFAULT_CASE_TIMEOUT_MS = 60_000;
export const DEFAULT_API_CONCURRENCY = 4;
export const DEFAULT_UI_CONCURRENCY = 1;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export const CREDENTIAL_NAME_MAX_LENGTH = 100;
export const SECRET_MAX_LENGTH = 8_192;
export const ENV_VAR_VALUE_MAX_LENGTH = 2_000;

/** 凭据、LLM/环境/渠道名称在所属范围内唯一，长度与项目名一致。 */
export const CONFIG_NAME_MAX_LENGTH = 100;

export const FEISHU_WEBHOOK_HOST_SUFFIXES = ['feishu.cn', 'larksuite.com'] as const;

export function normalizeProjectSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function projectSlugPolicyIssues(slug: string): string[] {
  const issues: string[] = [];

  if (slug.length < PROJECT_SLUG_MIN_LENGTH || slug.length > PROJECT_SLUG_MAX_LENGTH) {
    issues.push(
      `Project slug must be ${PROJECT_SLUG_MIN_LENGTH}-${PROJECT_SLUG_MAX_LENGTH} characters long`,
    );
  }

  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    issues.push('Project slug may only contain lowercase letters, digits or dashes');
  }

  return issues;
}

/** 是否包含 ASCII 控制字符（含 DEL）；路径与引用名都不允许。 */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * 仓库内相对路径校验：禁止绝对路径、盘符、反斜杠、`.`/`..` 段与控制字符。
 * 允许末尾斜杠，用于目录配置。
 */
export function repoRelativePathIssues(value: string): string[] {
  const issues: string[] = [];

  if (value.length === 0) {
    issues.push('Path must not be empty');

    return issues;
  }

  if (value.length > REPO_PATH_MAX_LENGTH) {
    issues.push(`Path must be at most ${REPO_PATH_MAX_LENGTH} characters`);
  }

  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    issues.push('Path must be relative');
  }

  if (value.includes('\\')) {
    issues.push('Path must use forward slashes');
  }

  if (hasControlCharacters(value)) {
    issues.push('Path must not contain control characters');
  }

  const trimmed = value.replace(/\/+$/, '');
  const segments = trimmed.split('/');

  if (
    trimmed.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    issues.push('Path must not contain empty, "." or ".." segments');
  }

  return issues;
}

/** 去除首尾空白、开头的 `./` 与末尾斜杠，用于持久化比较。 */
export function normalizeRepoPath(value: string): string {
  return value
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

/** 目录类路径统一保留一个末尾斜杠，便于文档与默认值展示。 */
export function normalizeRepoDir(value: string): string {
  const normalized = normalizeRepoPath(value);

  return normalized.length === 0 ? normalized : `${normalized}/`;
}

const GIT_REF_FORBIDDEN_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', ']', '\\']);

/** git check-ref-format 的核心约束；用于默认分支等引用名。 */
export function gitRefPolicyIssues(value: string): string[] {
  const issues: string[] = [];

  if (value.length === 0 || value.length > DEFAULT_BRANCH_MAX_LENGTH) {
    issues.push(`Git ref must be 1-${DEFAULT_BRANCH_MAX_LENGTH} characters long`);
  }

  if (value === '@') {
    issues.push('Git ref must not be "@"');
  }

  if (/\s/.test(value)) {
    issues.push('Git ref must not contain whitespace');
  }

  if (
    hasControlCharacters(value) ||
    [...value].some((character) => GIT_REF_FORBIDDEN_CHARACTERS.has(character))
  ) {
    issues.push('Git ref contains forbidden characters');
  }

  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{')
  ) {
    issues.push('Git ref is not a valid branch name');
  }

  return issues;
}

/**
 * 只有 HTTPS 且主机属于飞书/Lark 域名的 Webhook 才允许保存。
 * 主机必须是后缀本身或子域名，避免 `evil-feishu.cn` 之类的伪装域名。
 */
export function isFeishuWebhookUrl(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return false;
  }

  const host = url.hostname.toLowerCase();

  return FEISHU_WEBHOOK_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** 环境变量中禁止出现敏感值，敏感值必须通过凭据引用。 */
export function isSensitiveEnvVarName(name: string): boolean {
  return /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|access[_-]?key)/i.test(
    name,
  );
}
