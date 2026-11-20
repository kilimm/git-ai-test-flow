// 本文件所有改动要求遵循 agent-rules 规范
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from '@gait/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const CSRF_COOKIE_NAME = 'gait_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const HMAC_ALGORITHM = 'sha256';
const NONCE_LENGTH_BYTES = 32;

function signNonce(nonce: string, secret: string): string {
  return createHmac(HMAC_ALGORITHM, secret).update(nonce).digest('base64url');
}

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * 生成 CSRF double-submit token：随机 nonce + HMAC 签名。
 * 签名可避免攻击者通过写入 Cookie 实施 token fixation。
 */
export function createCsrfToken(secret: string): string {
  if (secret.length === 0) {
    throw new Error('CSRF secret must not be empty');
  }

  const nonce = randomBytes(NONCE_LENGTH_BYTES).toString('base64url');
  return `${nonce}.${signNonce(nonce, secret)}`;
}

export function verifyCsrfToken(token: string, secret: string): boolean {
  if (!CSRF_TOKEN_PATTERN.test(token)) {
    return false;
  }

  const separatorIndex = token.indexOf('.');
  const nonce = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);

  return timingSafeEqualStrings(signature, signNonce(nonce, secret));
}

/**
 * double-submit 校验：Cookie 与请求头中的 token 必须一致，且签名有效。
 */
export function verifyCsrfRequest(
  secret: string,
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (cookieToken === undefined || headerToken === undefined) {
    return false;
  }

  if (!timingSafeEqualStrings(cookieToken, headerToken)) {
    return false;
  }

  return verifyCsrfToken(headerToken, secret);
}

/**
 * CSRF Cookie 必须允许前端脚本读取，以便放入 X-CSRF-Token 请求头；
 * 会话 Cookie 仍保持 HttpOnly，二者职责不同。
 */
export function setCsrfCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    secure,
  });
}

/**
 * 变更请求的 CSRF 守卫。认证接口就绪后由 API 路由统一挂载。
 */
export function createCsrfGuard(secret: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (SAFE_METHODS.has(request.method)) {
      return;
    }

    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];
    const headerValue = request.headers[CSRF_HEADER_NAME];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!verifyCsrfRequest(secret, cookieToken, headerToken)) {
      throw new ForbiddenError('Invalid or missing CSRF token');
    }
  };
}
