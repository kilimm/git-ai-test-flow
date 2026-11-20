// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs } from '@gait/config';

export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1_000;
export const DEFAULT_MAX_ATTEMPTS_PER_ACCOUNT = 5;
export const DEFAULT_MAX_ATTEMPTS_PER_IP = 20;

const MAX_TRACKED_KEYS = 10_000;

export interface LoginRateLimiterOptions {
  windowMs?: number;
  maxAttemptsPerAccount?: number;
  maxAttemptsPerIp?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

interface Bucket {
  failures: number[];
}

/**
 * 登录限流：按 IP + 用户名和单 IP 两个维度统计失败次数。
 * 只记录失败，成功登录会清空该账号的失败计数。进程内存储，重启后清零；
 * 多实例部署时应在网关层补充限流。
 */
export class LoginRateLimiter {
  private readonly windowMs: number;
  private readonly maxAttemptsPerAccount: number;
  private readonly maxAttemptsPerIp: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_LOGIN_WINDOW_MS;
    this.maxAttemptsPerAccount = options.maxAttemptsPerAccount ?? DEFAULT_MAX_ATTEMPTS_PER_ACCOUNT;
    this.maxAttemptsPerIp = options.maxAttemptsPerIp ?? DEFAULT_MAX_ATTEMPTS_PER_IP;
    this.now = options.now ?? nowMs;
  }

  check(ip: string, username: string): RateLimitDecision {
    const now = this.now();
    this.prune(now);

    const accountRetry = this.retryAfter(
      this.accountKey(ip, username),
      this.maxAttemptsPerAccount,
      now,
    );
    const ipRetry = this.retryAfter(this.ipKey(ip), this.maxAttemptsPerIp, now);
    const retryAfterMs = Math.max(accountRetry, ipRetry);

    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  recordFailure(ip: string, username: string): void {
    const now = this.now();

    this.push(this.accountKey(ip, username), now);
    this.push(this.ipKey(ip), now);
    this.trim();
  }

  /** 成功登录后清空该账号的失败记录；IP 维度保留，防止用户名喷洒。 */
  reset(ip: string, username: string): void {
    this.buckets.delete(this.accountKey(ip, username));
  }

  clear(): void {
    this.buckets.clear();
  }

  private accountKey(ip: string, username: string): string {
    return `account:${ip}:${username}`;
  }

  private ipKey(ip: string): string {
    return `ip:${ip}`;
  }

  private retryAfter(key: string, limit: number, now: number): number {
    const bucket = this.buckets.get(key);

    if (bucket === undefined) {
      return 0;
    }

    const active = bucket.failures.filter((timestamp) => now - timestamp < this.windowMs);

    if (active.length !== bucket.failures.length) {
      bucket.failures = active;
    }

    if (active.length < limit) {
      return 0;
    }

    const oldest = active[active.length - limit];
    return oldest === undefined ? this.windowMs : Math.max(this.windowMs - (now - oldest), 1);
  }

  private push(key: string, now: number): void {
    const bucket = this.buckets.get(key);

    if (bucket === undefined) {
      this.buckets.set(key, { failures: [now] });
      return;
    }

    bucket.failures.push(now);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const active = bucket.failures.filter((timestamp) => now - timestamp < this.windowMs);

      if (active.length === 0) {
        this.buckets.delete(key);
      } else if (active.length !== bucket.failures.length) {
        bucket.failures = active;
      }
    }
  }

  private trim(): void {
    while (this.buckets.size > MAX_TRACKED_KEYS) {
      const oldest = this.buckets.keys().next();

      if (oldest.done === true) {
        return;
      }

      this.buckets.delete(oldest.value);
    }
  }
}
