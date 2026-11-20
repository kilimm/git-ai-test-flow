// 本文件所有改动要求遵循 agent-rules 规范
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from '@gait/shared';

export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionToken {
  token: string;
  tokenHash: string;
}

/** 数据库只保存 SHA-256 哈希，明文 token 只出现在 Cookie 中。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSessionToken(): SessionToken {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');

  return { token, tokenHash: hashSessionToken(token) };
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  const token = request.cookies?.[SESSION_COOKIE_NAME];

  return token !== undefined && SESSION_TOKEN_PATTERN.test(token) ? token : undefined;
}

export function sessionCookieSecure(nodeEnv: string): boolean {
  return nodeEnv === 'production';
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_ABSOLUTE_TTL_MS / 1_000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}
