// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { WorkerHeartbeatRepository } from '@gait/db';
import {
  bootstrapCsrf,
  closeTestApp,
  cookieHeader,
  createTestApp,
  login,
  seedTenant,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';

describe('operations endpoints', () => {
  it('reports not ready without a worker heartbeat and ready after one', async () => {
    const context = await createTestApp();

    const before = await context.app.inject({ method: 'GET', url: '/readyz' });
    const beforeBody = before.json() as {
      status: string;
      checks: Array<{ name: string; status: string }>;
    };

    expect(before.statusCode).toBe(503);
    expect(beforeBody.status).toBe('not_ready');
    expect(beforeBody.checks.find((check) => check.name === 'database')?.status).toBe('ok');
    expect(beforeBody.checks.find((check) => check.name === 'worker')?.status).toBe('failed');

    new WorkerHeartbeatRepository(context.database.db).record({
      workerId: 'worker-test',
      status: 'idle',
    });

    const after = await context.app.inject({ method: 'GET', url: '/readyz' });
    const afterBody = after.json() as { status: string };

    expect(after.statusCode).toBe(200);
    expect(afterBody.status).toBe('ready');

    await closeTestApp(context);
  });

  it('protects metrics and returns queue/run counters for platform admins', async () => {
    const context = await createTestApp();
    const tenant = seedTenant(context.database.db);

    await seedUser(context.database.db, {
      username: 'ops-admin',
      tenantId: tenant.id,
      role: 'owner',
      isPlatformAdmin: true,
    });

    const anonymous = await context.app.inject({ method: 'GET', url: '/api/v1/metrics' });

    expect(anonymous.statusCode).toBe(401);

    const csrf = await bootstrapCsrf(context.app);
    const session = await login(context.app, 'ops-admin', TEST_PASSWORD, csrf);
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/metrics',
      headers: { cookie: cookieHeader(session.cookies) },
    });
    const body = response.json() as {
      queue: { total: number };
      runs: Record<string, number>;
      classifications: Record<string, number>;
      workers: number;
    };

    expect(response.statusCode).toBe(200);
    expect(typeof body.queue.total).toBe('number');
    expect(typeof body.runs).toBe('object');
    expect(typeof body.classifications).toBe('object');
    expect(body.workers).toBe(0);

    await closeTestApp(context);
  });
});
