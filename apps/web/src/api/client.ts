// 本文件所有改动要求遵循 agent-rules 规范
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@gait/shared';
import type { AuthSessionSummary, Permission, TenantSummary } from '@gait/shared';

export const API_PREFIX = '/api/v1';

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

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return found === undefined ? undefined : decodeURIComponent(found.slice(prefix.length));
}

/**
 * 变更请求使用 double-submit CSRF：Cookie 由服务端写入，请求头携带同一 token。
 * Cookie 缺失时先获取 /auth/csrf，避免登录页首次请求被 403。
 */
async function getCsrfToken(): Promise<string> {
  const fromCookie = readCookie(CSRF_COOKIE_NAME);

  if (fromCookie !== undefined && fromCookie.length > 0) {
    return fromCookie;
  }

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

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (!SAFE_METHODS.has(method)) {
    headers[CSRF_HEADER_NAME] = await getCsrfToken();
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
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

export interface SwitchTenantResult {
  activeTenant: TenantSummary;
  tenants: TenantSummary[];
  permissions: Permission[];
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
};
