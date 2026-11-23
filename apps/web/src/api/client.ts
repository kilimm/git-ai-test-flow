// 本文件所有改动要求遵循 agent-rules 规范
import { CSRF_HEADER_NAME } from '@gait/shared';
import type {
  AuthSessionSummary,
  GenerationGranularity,
  ModuleTreeNode,
  Permission,
  TenantRole,
  TenantSummary,
} from '@gait/shared';
import type {
  AuditEntry,
  CaseFile,
  CaseItem,
  Credential,
  DocCommitEntryRecord,
  DocModuleRecord,
  DocVersionRecord,
  EnvironmentProfile,
  Generation,
  GenerationDetail,
  LlmProfile,
  Member,
  NotificationChannel,
  Project,
  ProjectAccess,
  ProjectRole,
  RepairAttempt,
  RunDetail,
  RunReport,
  RunSummary,
  ProjectCommitOption,
  SsoProvider,
  TestResult,
  TriggerConfig,
} from './types';

// Subpath-aware: when the app is served under a base path (vite base, e.g. /gait/),
// API calls must carry the same prefix. Defaults to '/api/v1' at site root.
export const API_PREFIX = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/v1`;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface ProblemBody {
  code?: string;
  detail?: string;
  title?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 变更请求使用 double-submit CSRF：Cookie 由服务端写入，请求头携带同一 token。
 * Cookie 缺失时先获取 /auth/csrf，避免登录页首次请求被 403。
 */
async function getCsrfToken(): Promise<string> {
  // 始终向服务端获取新 token，而不是复用已有 Cookie：
  // 部署更换 SESSION_SECRET 后，浏览器里残留的旧 gait_csrf 会因 HMAC 校验失败
  // 导致“Invalid or missing CSRF token”。GET /auth/csrf 会同时刷新 Cookie。
  const response = await fetch(`${API_PREFIX}/auth/csrf`, {
    method: 'GET',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new ApiError(response.status, 'CSRF_UNAVAILABLE', '无法初始化安全令牌，请刷新页面重试');
  }

  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ProblemBody = {};

  try {
    body = (await response.json()) as ProblemBody;
  } catch {
    // 非 JSON 错误响应使用默认提示。
  }

  return new ApiError(
    response.status,
    body.code ?? 'HTTP_ERROR',
    body.detail ?? body.title ?? `请求失败（HTTP ${response.status}）`,
  );
}

function queryString(query?: Record<string, string | number | undefined>): string {
  if (query === undefined) {
    return '';
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }

  const serialized = params.toString();

  return serialized.length === 0 ? '' : `?${serialized}`;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (!SAFE_METHODS.has(method)) {
    headers[CSRF_HEADER_NAME] = await getCsrfToken();
  }

  const response = await fetch(`${API_PREFIX}${path}${queryString(query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    credentials: 'same-origin',
    headers: { Accept: 'text/plain, application/json' },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.text();
}

export interface SwitchTenantResult {
  activeTenant: TenantSummary;
  tenants: TenantSummary[];
  permissions: Permission[];
}

export interface ProjectInput {
  name: string;
  slug: string;
  productRepoUrl: string;
  defaultBranch: string;
  gitCredentialId?: string | null;
  suiteMode: 'managed' | 'external' | 'same_repo';
  suiteRepoUrl?: string | null;
  suitePath?: string | null;
  featureRoot?: string;
  docsRoot?: string;
}

export interface CredentialInput {
  name: string;
  type: string;
  username?: string | null;
  secret: string;
  expiresAt?: string | null;
}

export interface EnvironmentInput {
  name: string;
  apiBaseUrl: string;
  webBaseUrl?: string | null;
  healthcheck?: { url: string; expectedStatus: number; timeoutMs: number } | null;
  version?: {
    source: string;
    endpoint?: string | null;
    jsonPath?: string | null;
    header?: string | null;
    deployedSha?: string | null;
    strictVersionMatch: boolean;
  };
  testAccountCredentialId?: string | null;
  setupScript?: string | null;
  envVars?: Record<string, string>;
  db?: {
    type: string;
    host?: string | null;
    port?: number | null;
    name: string;
    schema?: string | null;
    user?: string | null;
    credentialId?: string | null;
    ssl: boolean;
    isTest: boolean;
    writeMode: string;
  } | null;
  caseTimeoutMs?: number;
  apiConcurrency?: number;
  uiConcurrency?: number;
  isDefault?: boolean;
  confirmDangerous?: boolean;
}

export interface LlmProfileInput {
  name: string;
  purpose: string;
  provider: string;
  baseUrl: string;
  model: string;
  credentialId?: string | null;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

export interface NotificationChannelInput {
  name: string;
  webhookUrl: string;
  secret: string;
  events: string[];
  enabled: boolean;
}

export interface CreateRunInput {
  environmentId?: string;
  baselineEnvironmentId?: string;
  baseSha?: string;
  headSha: string;
  branch?: string;
  generationId?: string;
  selection?: {
    type: 'all' | 'modules' | 'cases' | 'impact';
    modules?: string[];
    caseKeys?: string[];
  };
}

export interface TriggerInput {
  name: string;
  type: 'schedule' | 'git_webhook' | 'deployment';
  action: 'generate' | 'run';
  enabled?: boolean;
  cron?: string;
  branch?: string;
  environmentId?: string;
  selection?: CreateRunInput['selection'];
}

export const api = {
  getSession(): Promise<AuthSessionSummary> {
    return request<AuthSessionSummary>('GET', '/me');
  },
  login(username: string, password: string): Promise<AuthSessionSummary> {
    return request<AuthSessionSummary>('POST', '/auth/login', { username, password });
  },
  logout(): Promise<void> {
    return request<void>('POST', '/auth/logout');
  },
  switchTenant(tenantId: string): Promise<SwitchTenantResult> {
    return request<SwitchTenantResult>('POST', '/me/active-tenant', { tenantId });
  },

  listProjects(tenantId: string): Promise<Project[]> {
    return request<{ items: Project[] }>('GET', `/tenants/${tenantId}/projects`).then(
      (result) => result.items,
    );
  },
  getProject(projectId: string): Promise<Project> {
    return request<{ project: Project }>('GET', `/projects/${projectId}`).then(
      (result) => result.project,
    );
  },
  createProject(tenantId: string, input: ProjectInput): Promise<Project> {
    return request<{ project: Project }>('POST', `/tenants/${tenantId}/projects`, input).then(
      (result) => result.project,
    );
  },
  updateProject(projectId: string, input: Partial<ProjectInput>): Promise<Project> {
    return request<{ project: Project }>('PATCH', `/projects/${projectId}`, input).then(
      (result) => result.project,
    );
  },
  deleteProject(projectId: string): Promise<void> {
    return request<void>('DELETE', `/projects/${projectId}`);
  },
  testProjectConnection(projectId: string): Promise<TestResult> {
    return request<TestResult>('POST', `/projects/${projectId}/test-connection`);
  },

  listCredentials(projectId: string): Promise<Credential[]> {
    return request<{ items: Credential[] }>('GET', `/projects/${projectId}/credentials`).then(
      (result) => result.items,
    );
  },
  createCredential(projectId: string, input: CredentialInput): Promise<Credential> {
    return request<{ credential: Credential }>(
      'POST',
      `/projects/${projectId}/credentials`,
      input,
    ).then((result) => result.credential);
  },
  updateCredential(credentialId: string, input: Partial<CredentialInput>): Promise<Credential> {
    return request<{ credential: Credential }>('PATCH', `/credentials/${credentialId}`, input).then(
      (result) => result.credential,
    );
  },
  deleteCredential(credentialId: string): Promise<void> {
    return request<void>('DELETE', `/credentials/${credentialId}`);
  },
  testCredential(credentialId: string): Promise<TestResult> {
    return request<TestResult>('POST', `/credentials/${credentialId}/test`);
  },

  listLlmProfiles(projectId: string): Promise<LlmProfile[]> {
    return request<{ items: LlmProfile[] }>('GET', `/projects/${projectId}/llm-profiles`).then(
      (result) => result.items,
    );
  },
  createLlmProfile(projectId: string, input: LlmProfileInput): Promise<LlmProfile> {
    return request<{ profile: LlmProfile }>(
      'POST',
      `/projects/${projectId}/llm-profiles`,
      input,
    ).then((result) => result.profile);
  },
  updateLlmProfile(profileId: string, input: Partial<LlmProfileInput>): Promise<LlmProfile> {
    return request<{ profile: LlmProfile }>('PATCH', `/llm-profiles/${profileId}`, input).then(
      (result) => result.profile,
    );
  },
  deleteLlmProfile(profileId: string): Promise<void> {
    return request<void>('DELETE', `/llm-profiles/${profileId}`);
  },
  testLlmProfile(profileId: string): Promise<TestResult> {
    return request<TestResult>('POST', `/llm-profiles/${profileId}/test`);
  },

  listEnvironments(projectId: string): Promise<EnvironmentProfile[]> {
    return request<{ items: EnvironmentProfile[] }>(
      'GET',
      `/projects/${projectId}/environments`,
    ).then((result) => result.items);
  },
  createEnvironment(projectId: string, input: EnvironmentInput): Promise<EnvironmentProfile> {
    return request<{ environment: EnvironmentProfile }>(
      'POST',
      `/projects/${projectId}/environments`,
      input,
    ).then((result) => result.environment);
  },
  updateEnvironment(
    environmentId: string,
    input: Partial<EnvironmentInput>,
  ): Promise<EnvironmentProfile> {
    return request<{ environment: EnvironmentProfile }>(
      'PATCH',
      `/environments/${environmentId}`,
      input,
    ).then((result) => result.environment);
  },
  deleteEnvironment(environmentId: string): Promise<void> {
    return request<void>('DELETE', `/environments/${environmentId}`);
  },
  testEnvironment(environmentId: string): Promise<TestResult> {
    return request<TestResult>('POST', `/environments/${environmentId}/test`);
  },

  listNotificationChannels(projectId: string): Promise<NotificationChannel[]> {
    return request<{ items: NotificationChannel[] }>(
      'GET',
      `/projects/${projectId}/notification-channels`,
    ).then((result) => result.items);
  },
  createNotificationChannel(
    projectId: string,
    input: NotificationChannelInput,
  ): Promise<NotificationChannel> {
    return request<{ channel: NotificationChannel }>(
      'POST',
      `/projects/${projectId}/notification-channels`,
      input,
    ).then((result) => result.channel);
  },
  updateNotificationChannel(
    channelId: string,
    input: Partial<NotificationChannelInput>,
  ): Promise<NotificationChannel> {
    return request<{ channel: NotificationChannel }>(
      'PATCH',
      `/notification-channels/${channelId}`,
      input,
    ).then((result) => result.channel);
  },
  deleteNotificationChannel(channelId: string): Promise<void> {
    return request<void>('DELETE', `/notification-channels/${channelId}`);
  },
  testNotificationChannel(channelId: string): Promise<TestResult> {
    return request<TestResult>('POST', `/notification-channels/${channelId}/test`);
  },

  listMembers(tenantId: string): Promise<Member[]> {
    return request<{ items: Member[] }>('GET', `/tenants/${tenantId}/members`).then(
      (result) => result.items,
    );
  },
  addMember(
    tenantId: string,
    input: {
      username: string;
      role: TenantRole;
      password?: string;
      displayName?: string;
      email?: string;
    },
  ): Promise<Member> {
    return request<{ member: Member }>('POST', `/tenants/${tenantId}/members`, input).then(
      (result) => result.member,
    );
  },
  updateMemberRole(tenantId: string, userId: string, role: TenantRole): Promise<Member> {
    return request<{ member: Member }>('PATCH', `/tenants/${tenantId}/members/${userId}`, {
      role,
    }).then((result) => result.member);
  },
  removeMember(tenantId: string, userId: string): Promise<void> {
    return request<void>('DELETE', `/tenants/${tenantId}/members/${userId}`);
  },

  listAudit(
    query: { limit?: number; cursor?: string; action?: string; resourceType?: string } = {},
  ): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
    return request<{ items: AuditEntry[]; nextCursor: string | null }>(
      'GET',
      '/audit-logs',
      undefined,
      query,
    );
  },

  /** 读取项目最近提交（时间倒序），供创建运行时选择 Head/Base SHA。 */
  listProjectCommits(
    projectId: string,
    options: { ref?: string; limit?: number } = {},
  ): Promise<{
    items: ProjectCommitOption[];
    headSha: string | null;
    latestSha?: string;
    warning?: string;
  }> {
    const query = new URLSearchParams();

    if (options.ref !== undefined) {
      query.set('ref', options.ref);
    }

    if (options.limit !== undefined) {
      query.set('limit', String(options.limit));
    }

    const suffix = query.toString().length === 0 ? '' : `?${query.toString()}`;

    return request<{
      items: ProjectCommitOption[];
      headSha: string | null;
      latestSha?: string;
      warning?: string;
    }>('GET', `/projects/${projectId}/commits${suffix}`);
  },
  listGenerations(projectId: string): Promise<Generation[]> {
    return request<{ items: Generation[] }>('GET', `/projects/${projectId}/generations`).then(
      (result) => result.items,
    );
  },
  /** 读取最近一次模块扫描结果（可能为空，需要先 scanProjectModules）。 */
  listProjectModules(projectId: string): Promise<{
    projectId: string;
    modules: ModuleTreeNode[];
    scannedFiles: number;
    truncated: boolean;
    scannedAt: string | null;
  }> {
    return request<{
      projectId: string;
      modules: ModuleTreeNode[];
      scannedFiles: number;
      truncated: boolean;
      scannedAt: string | null;
    }>('GET', `/projects/${projectId}/modules`);
  },
  /** 触发模块扫描（异步 job）；完成后再次调用 listProjectModules 获取结果。 */
  scanProjectModules(projectId: string, ref?: string): Promise<{ queued: boolean; ref: string }> {
    return request<{ queued: boolean; ref: string }>(
      'POST',
      `/projects/${projectId}/modules/scan`,
      ref === undefined ? {} : { ref },
    );
  },
  getGeneration(generationId: string): Promise<GenerationDetail> {
    return request<{ generation: GenerationDetail }>('GET', `/generations/${generationId}`).then(
      (result) => result.generation,
    );
  },
  createGeneration(
    projectId: string,
    input: {
      mode: 'current' | 'range' | 'baseline';
      granularity?: GenerationGranularity;
      baseSha?: string;
      headSha?: string;
      branch?: string;
      selection?: { modules: string[] };
    },
  ): Promise<{ generation: Generation; created: boolean }> {
    return request<{ generation: Generation; created: boolean }>(
      'POST',
      `/projects/${projectId}/generations`,
      input,
    );
  },
  editGenerationFile(
    generationId: string,
    fileId: string,
    content: string,
  ): Promise<GenerationDetail> {
    return request<{ generation: GenerationDetail }>(
      'PATCH',
      `/generations/${generationId}/files/${fileId}`,
      { content },
    ).then((result) => result.generation);
  },
  approveGeneration(
    generationId: string,
    message?: string,
  ): Promise<{ generation: GenerationDetail; commit: { commitSha: string; changed: boolean } }> {
    return request<{
      generation: GenerationDetail;
      commit: { commitSha: string; changed: boolean };
    }>('POST', `/generations/${generationId}/approve`, message === undefined ? {} : { message });
  },
  rejectGeneration(generationId: string, reason?: string): Promise<GenerationDetail> {
    return request<{ generation: GenerationDetail }>(
      'POST',
      `/generations/${generationId}/reject`,
      reason === undefined ? {} : { reason },
    ).then((result) => result.generation);
  },

  listRuns(projectId: string): Promise<RunSummary[]> {
    return request<{ items: RunSummary[] }>('GET', `/projects/${projectId}/runs`).then(
      (result) => result.items,
    );
  },
  getRun(runId: string): Promise<RunDetail> {
    return request<{ run: RunDetail }>('GET', `/runs/${runId}`).then((result) => result.run);
  },
  createRun(
    projectId: string,
    input: CreateRunInput,
  ): Promise<{ run: RunSummary; created: boolean }> {
    return request<{ run: RunSummary; created: boolean }>(
      'POST',
      `/projects/${projectId}/runs`,
      input,
    );
  },
  cancelRun(runId: string): Promise<RunDetail> {
    return request<{ run: RunDetail }>('POST', `/runs/${runId}/cancel`).then(
      (result) => result.run,
    );
  },
  getRunReport(runId: string): Promise<RunReport> {
    return request<{ report: RunReport }>('GET', `/runs/${runId}/report`).then(
      (result) => result.report,
    );
  },
  artifactUrl(runId: string, artifactId: string): string {
    return `${API_PREFIX}/runs/${runId}/artifacts/${artifactId}`;
  },
  artifactText(runId: string, artifactId: string): Promise<string> {
    return fetchText(`/runs/${runId}/artifacts/${artifactId}`);
  },

  listFeatureFiles(projectId: string): Promise<CaseFile[]> {
    return request<{ items: CaseFile[] }>('GET', `/projects/${projectId}/feature-files`).then(
      (result) => result.items,
    );
  },
  listCases(
    projectId: string,
    query: { query?: string; module?: string } = {},
  ): Promise<CaseItem[]> {
    return request<{ items: CaseItem[] }>(
      'GET',
      `/projects/${projectId}/cases`,
      undefined,
      query,
    ).then((result) => result.items);
  },

  getProjectAccess(projectId: string): Promise<ProjectAccess> {
    return request<{ access: ProjectAccess }>('GET', `/projects/${projectId}/access`).then(
      (result) => result.access,
    );
  },
  updateProjectAccess(
    projectId: string,
    accessMode: 'tenant' | 'restricted',
  ): Promise<ProjectAccess> {
    return request<{ access: ProjectAccess }>('PATCH', `/projects/${projectId}/access`, {
      accessMode,
    }).then((result) => result.access);
  },
  addProjectMember(projectId: string, username: string, role: ProjectRole): Promise<ProjectAccess> {
    return request<{ access: ProjectAccess }>('POST', `/projects/${projectId}/members`, {
      username,
      role,
    }).then((result) => result.access);
  },
  updateProjectMember(
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectAccess> {
    return request<{ access: ProjectAccess }>('PATCH', `/projects/${projectId}/members/${userId}`, {
      role,
    }).then((result) => result.access);
  },
  removeProjectMember(projectId: string, userId: string): Promise<void> {
    return request<void>('DELETE', `/projects/${projectId}/members/${userId}`);
  },

  listRepairs(runCaseId: string): Promise<RepairAttempt[]> {
    return request<{ items: RepairAttempt[] }>('GET', `/run-cases/${runCaseId}/repairs`).then(
      (result) => result.items,
    );
  },
  approveRepair(runCaseId: string, repairId: string): Promise<RepairAttempt> {
    return request<{ repair: RepairAttempt }>(
      'POST',
      `/run-cases/${runCaseId}/repairs/${repairId}/approve`,
    ).then((result) => result.repair);
  },
  rejectRepair(runCaseId: string, repairId: string): Promise<RepairAttempt> {
    return request<{ repair: RepairAttempt }>(
      'POST',
      `/run-cases/${runCaseId}/repairs/${repairId}/reject`,
    ).then((result) => result.repair);
  },
  rollbackRepair(runCaseId: string, repairId: string): Promise<RepairAttempt> {
    return request<{ repair: RepairAttempt }>(
      'POST',
      `/run-cases/${runCaseId}/repairs/${repairId}/rollback`,
    ).then((result) => result.repair);
  },

  listDocModules(projectId: string): Promise<DocModuleRecord[]> {
    return request<{ items: DocModuleRecord[] }>('GET', `/projects/${projectId}/doc-modules`).then(
      (result) => result.items,
    );
  },
  getDocModule(moduleId: string): Promise<{
    module: DocModuleRecord;
    version: DocVersionRecord | null;
  }> {
    return request<{ module: DocModuleRecord; version: DocVersionRecord | null }>(
      'GET',
      `/doc-modules/${moduleId}`,
    );
  },
  listDocVersions(moduleId: string): Promise<DocVersionRecord[]> {
    return request<{ items: DocVersionRecord[] }>('GET', `/doc-modules/${moduleId}/versions`).then(
      (result) => result.items,
    );
  },
  listDocEntries(projectId: string, limit = 100): Promise<DocCommitEntryRecord[]> {
    return request<{ items: DocCommitEntryRecord[] }>(
      'GET',
      `/projects/${projectId}/doc-entries`,
      undefined,
      { limit },
    ).then((result) => result.items);
  },
  docDiff(moduleId: string, from: string, to: string): Promise<{ diff: string }> {
    return request<{ diff: string }>('GET', `/doc-modules/${moduleId}/diff`, undefined, {
      from,
      to,
    });
  },
  regenerateDocs(projectId: string): Promise<{ jobId: string }> {
    return request<{ jobId: string }>('POST', `/projects/${projectId}/docs/regenerate`, {});
  },
  compressDocs(projectId: string): Promise<{ jobId: string }> {
    return request<{ jobId: string }>('POST', `/projects/${projectId}/docs/compress`, {});
  },
  editDoc(moduleId: string, content: string): Promise<DocVersionRecord> {
    return request<{ version: DocVersionRecord }>('PATCH', `/doc-modules/${moduleId}`, {
      content,
    }).then((result) => result.version);
  },

  listTriggers(projectId: string): Promise<TriggerConfig[]> {
    return request<{ items: TriggerConfig[] }>('GET', `/projects/${projectId}/triggers`).then(
      (result) => result.items,
    );
  },
  createTrigger(
    projectId: string,
    input: TriggerInput,
  ): Promise<{ trigger: TriggerConfig; token: string | null }> {
    return request<{ trigger: TriggerConfig; token: string | null }>(
      'POST',
      `/projects/${projectId}/triggers`,
      input,
    );
  },
  updateTrigger(
    projectId: string,
    triggerId: string,
    input: Partial<TriggerInput> & { rotateToken?: boolean },
  ): Promise<{ trigger: TriggerConfig; token: string | null }> {
    return request<{ trigger: TriggerConfig; token: string | null }>(
      'PATCH',
      `/projects/${projectId}/triggers/${triggerId}`,
      input,
    );
  },
  deleteTrigger(projectId: string, triggerId: string): Promise<void> {
    return request<void>('DELETE', `/projects/${projectId}/triggers/${triggerId}`);
  },

  listSsoProviders(tenantSlug: string): Promise<SsoProvider[]> {
    return request<{ items: SsoProvider[] }>(
      'GET',
      `/auth/sso/${encodeURIComponent(tenantSlug)}/providers`,
    ).then((result) => result.items);
  },
  ssoStartUrl(providerId: string, redirect = '/'): string {
    return `${API_PREFIX}/auth/sso/${encodeURIComponent(providerId)}/start?redirect=${encodeURIComponent(redirect)}`;
  },

  runEventsUrl(runId: string): string {
    return `${API_PREFIX}/runs/${runId}/events`;
  },
  generationEventsUrl(generationId: string): string {
    return `${API_PREFIX}/generations/${generationId}/events`;
  },
};

export function hasPermission(
  permissions: readonly Permission[] | undefined,
  permission: Permission,
): boolean {
  return permissions?.includes(permission) ?? false;
}
