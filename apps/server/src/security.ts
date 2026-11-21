// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitError } from '@gait/config';

export const API_RATE_LIMIT_MINUTE = 600;

export interface SecurityHeadersOptions {
  production: boolean;
}

/**
 * 安全响应头：
 * - API 返回 JSON/文件，不允许被嵌入或作为 HTML 执行；
 * - 生产环境启用 HSTS；
 * - 不设置 CORS 通配，Web 与 API 由同源反向代理提供。
 */
export function applySecurityHeaders(reply: FastifyReply, options: SecurityHeadersOptions): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header(
    'content-security-policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );

  if (options.production) {
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    applySecurityHeaders(reply, options);
    return payload;
  });
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** 进程内固定窗口限流，用于 API 入口；多实例部署需替换为共享存储。 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new RangeError('limit must be a positive integer');
    }

    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('windowMs must be a positive integer');
    }

    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitStatus {
    const now = this.now();
    const current = this.entries.get(key);

    if (current === undefined || current.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.entries.set(key, { count: 1, resetAt });

      return { allowed: true, remaining: this.limit - 1, resetAt };
    }

    current.count += 1;
    this.prune(now);

    return {
      allowed: current.count <= this.limit,
      remaining: Math.max(0, this.limit - current.count),
      resetAt: current.resetAt,
    };
  }

  reset(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    if (this.entries.size < 2_000) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export interface ApiRateLimitOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
  /** 健康检查与 Webhook 等路径可按需跳过。 */
  skip?: ((request: FastifyRequest) => boolean) | undefined;
}

/** 在 API 插件内注册全局限流；超限返回 429 与 Retry-After。 */
export function registerApiRateLimit(
  app: FastifyInstance,
  options: ApiRateLimitOptions = {},
): FixedWindowRateLimiter {
  const limiter = new FixedWindowRateLimiter({
    limit: options.limit ?? API_RATE_LIMIT_MINUTE,
    windowMs: options.windowMs ?? 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  app.addHook('onRequest', async (request, reply) => {
    if (options.skip?.(request) === true) {
      return;
    }

    const key = `${request.ip}:${request.method === 'POST' ? 'write' : 'read'}`;
    const status = limiter.check(key);

    reply.header('x-ratelimit-limit', String(options.limit ?? API_RATE_LIMIT_MINUTE));
    reply.header('x-ratelimit-remaining', String(status.remaining));
    reply.header('x-ratelimit-reset', new Date(status.resetAt).toISOString());

    if (!status.allowed) {
      reply.header(
        'retry-after',
        String(Math.max(1, Math.ceil((status.resetAt - Date.now()) / 1_000))),
      );
      throw new RateLimitError('Too many requests, try again later');
    }
  });

  return limiter;
}
