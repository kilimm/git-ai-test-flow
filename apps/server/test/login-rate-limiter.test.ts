// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../src/auth/login-rate-limiter.js';

describe('LoginRateLimiter', () => {
  it('allows failures up to the per-account limit and blocks afterwards', () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter({ windowMs: 60_000, now: () => now });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.check('10.0.0.1', 'alice').allowed).toBe(true);
      limiter.recordFailure('10.0.0.1', 'alice');
    }

    const blocked = limiter.check('10.0.0.1', 'alice');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // 其他账号和其他 IP 不受影响。
    expect(limiter.check('10.0.0.1', 'bob').allowed).toBe(true);
    expect(limiter.check('10.0.0.2', 'alice').allowed).toBe(true);

    now += 60_000;
    expect(limiter.check('10.0.0.1', 'alice').allowed).toBe(true);
  });

  it('enforces the per-IP limit across usernames', () => {
    let now = 0;
    const limiter = new LoginRateLimiter({
      windowMs: 60_000,
      maxAttemptsPerIp: 3,
      maxAttemptsPerAccount: 10,
      now: () => now,
    });

    limiter.recordFailure('10.0.0.1', 'a');
    limiter.recordFailure('10.0.0.1', 'b');
    limiter.recordFailure('10.0.0.1', 'c');

    expect(limiter.check('10.0.0.1', 'd').allowed).toBe(false);
    expect(limiter.check('10.0.0.2', 'd').allowed).toBe(true);

    now += 30_000;
    expect(limiter.check('10.0.0.1', 'd').retryAfterMs).toBe(30_000);
  });

  it('resets the account bucket after a successful login', () => {
    const limiter = new LoginRateLimiter({ now: () => 0 });

    limiter.recordFailure('10.0.0.1', 'alice');
    limiter.recordFailure('10.0.0.1', 'alice');
    limiter.reset('10.0.0.1', 'alice');

    // 账号桶已清空，但 IP 桶仍有 2 次失败。
    expect(limiter.check('10.0.0.1', 'alice').allowed).toBe(true);

    for (let attempt = 0; attempt < 18; attempt += 1) {
      limiter.recordFailure('10.0.0.1', 'someone');
    }

    expect(limiter.check('10.0.0.1', 'alice').allowed).toBe(false);
    limiter.clear();
    expect(limiter.check('10.0.0.1', 'alice').allowed).toBe(true);
  });
});
