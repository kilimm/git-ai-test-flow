// 本文件所有改动要求遵循 agent-rules 规范
export { buildApp, HEALTH_PATH } from './app.js';
export type { BuildAppOptions } from './app.js';
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createCsrfGuard,
  createCsrfToken,
  setCsrfCookie,
  verifyCsrfRequest,
  verifyCsrfToken,
} from './csrf.js';
export { getRequestPath, toHttpProblem } from './problem.js';
export { REQUEST_ID_HEADER, REQUEST_ID_RESPONSE_HEADER, resolveRequestId } from './request-id.js';
export { createGracefulShutdown } from './shutdown.js';
export type { ShutdownApp, ShutdownHandler } from './shutdown.js';

export const SERVER_APP_NAME = '@gait/server';
