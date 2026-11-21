// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, applySecurityHeaders } from '../src/security.js';
import { closeTestApp, createTestApp } from './helpers.js';

describe('security hardening', () => {
  it('sets security headers on health responses', async () => {
    const context = await createTestApp();

    try {
      const response = await context.app.inject({ method: 'GET', url: '/healthz' });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await closeTestApp(context);
    }
  });

  it('adds HSTS only in production', () => {
    const headers: Record<string, string> = {};
    const reply = {
      header(name: string, value: string) {
        headers[name] = value;
        return this;
      },
    };

    applySecurityHeaders(reply as never, { production: true });

    expect(headers['strict-transport-security']).toContain('max-age=31536000');
  });

  it('limits API requests per IP and returns RFC 7807 with retry-after', async () => {
    const context = await createTestApp({ apiRateLimit: { limit: 2, windowMs: 60_000 } });

    try {
      const first = await context.app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
      const second = await context.app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
      const third = await context.app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
      const body = third.json() as { code: string; status: number };

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.headers['retry-after']).toBeDefined();
      expect(third.headers['content-type']).toContain('application/problem+json');
      expect(body.code).toBe('RATE_LIMITED');
      expect(body.status).toBe(429);
    } finally {
      await closeTestApp(context);
    }
  });

  it('resets the fixed window after expiry', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 100, now: () => now });

    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);

    now = 1_101;

    expect(limiter.check('ip').allowed).toBe(true);
  });
});
