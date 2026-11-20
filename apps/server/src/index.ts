// 本文件所有改动要求遵循 agent-rules 规范
export { buildApp, HEALTH_PATH } from './app.js';
export type { BuildAppOptions } from './app.js';
export { API_PREFIX, registerApiRoutes } from './api/routes.js';
export type { ApiDependencies } from './api/routes.js';
export { AuthService, toAuthUserSummary, toTenantSummary } from './auth/auth-service.js';
export type {
  AuthContext,
  AuthServiceOptions,
  ChangePasswordInput,
  LoginInput,
  LoginResult,
  RequestMeta,
  SwitchTenantResult,
} from './auth/auth-service.js';
export { createAuthGuards, getAuthContext, getRequestMeta } from './auth/guards.js';
export type { AuthGuards, CreateGuardsOptions } from './auth/guards.js';
export {
  LoginRateLimiter,
  DEFAULT_LOGIN_WINDOW_MS,
  DEFAULT_MAX_ATTEMPTS_PER_ACCOUNT,
  DEFAULT_MAX_ATTEMPTS_PER_IP,
} from './auth/login-rate-limiter.js';
export type { LoginRateLimiterOptions, RateLimitDecision } from './auth/login-rate-limiter.js';
export {
  clearSessionCookie,
  createSessionToken,
  hashSessionToken,
  readSessionToken,
  sessionCookieSecure,
  setSessionCookie,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './auth/session-token.js';
export type { SessionToken } from './auth/session-token.js';
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createCsrfGuard,
  createCsrfToken,
  SAFE_METHODS,
  setCsrfCookie,
  verifyCsrfRequest,
  verifyCsrfToken,
} from './csrf.js';
export { getRequestPath, toHttpProblem } from './problem.js';
export { REQUEST_ID_HEADER, REQUEST_ID_RESPONSE_HEADER, resolveRequestId } from './request-id.js';
export { createGracefulShutdown } from './shutdown.js';
export type { ShutdownApp, ShutdownHandler } from './shutdown.js';
export { MemberService } from './tenants/member-service.js';
export type { AddMemberInput, MemberServiceOptions, MemberView } from './tenants/member-service.js';
export { TenantService } from './tenants/tenant-service.js';
export type { TenantServiceOptions } from './tenants/tenant-service.js';

export const SERVER_APP_NAME = '@gait/server';
