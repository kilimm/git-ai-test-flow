// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedTenant,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);

  return sorted[index] ?? 0;
}

describe('critical API latency', () => {
  it('keeps project listing p95 below 500ms on the local SQLite baseline', async () => {
    const context = await createTestApp();
    const tenant = seedTenant(context.database.db);

    await seedUser(context.database.db, {
      username: 'perf-owner',
      tenantId: tenant.id,
      role: 'owner',
    });

    const session = await login(context.app, 'perf-owner', TEST_PASSWORD);
    const durations: number[] = [];

    // 预热一次，避免首次路由编译计入分位数。
    await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/tenants/${tenant.id}/projects`,
      session,
    });

    for (let index = 0; index < 50; index += 1) {
      const startedAt = performance.now();
      const response = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/tenants/${tenant.id}/projects`,
        session,
      });

      durations.push(performance.now() - startedAt);
      expect(response.statusCode).toBe(200);
    }

    const p95 = percentile(durations, 0.95);

    expect(p95, `p95=${p95.toFixed(1)}ms`).toBeLessThanOrEqual(500);

    await closeTestApp(context);
  });
});
