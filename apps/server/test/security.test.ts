// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, MEMBER_STATUS } from '@gait/shared';
import { MembershipRepository } from '@gait/db';
import {
  authedRequest,
  bootstrapCsrf,
  closeTestApp,
  cookieHeader,
  createTestApp,
  login,
  seedTenant,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';

async function withApp(run: (context: TestAppContext) => Promise<void>): Promise<void> {
  const context = await createTestApp();

  try {
    await run(context);
  } finally {
    await closeTestApp(context);
  }
}

describe('tenant isolation', () => {
  it('returns 404 for every cross-tenant tenant and member endpoint', async () => {
    await withApp(async ({ app, database }) => {
      const tenantA = await seedTenant(database.db, 'tenant-a');
      const tenantB = await seedTenant(database.db, 'tenant-b');
      const owner = await seedUser(database.db, {
        username: 'owner',
        tenantId: tenantA.id,
        role: 'owner',
      });
      const foreignMember = await seedUser(database.db, {
        username: 'foreign',
        tenantId: tenantB.id,
        role: 'viewer',
      });
      const session = await login(app, 'owner', TEST_PASSWORD);

      const cases: Array<{
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
        url: string;
        payload?: unknown;
      }> = [
        { method: 'GET', url: `/api/v1/tenants/${tenantB.id}` },
        { method: 'PATCH', url: `/api/v1/tenants/${tenantB.id}`, payload: { name: 'Hijacked' } },
        { method: 'GET', url: `/api/v1/tenants/${tenantB.id}/members` },
        {
          method: 'POST',
          url: `/api/v1/tenants/${tenantB.id}/members`,
          payload: { username: 'intruder', role: 'owner', password: 'intruder-password-1' },
        },
        {
          method: 'PATCH',
          url: `/api/v1/tenants/${tenantB.id}/members/${foreignMember.id}`,
          payload: { role: 'viewer' },
        },
        {
          method: 'DELETE',
          url: `/api/v1/tenants/${tenantB.id}/members/${foreignMember.id}`,
        },
        { method: 'GET', url: `/api/v1/tenants/${tenantB.id}?tenantId=${tenantA.id}` },
      ];

      for (const testCase of cases) {
        const response = await authedRequest(app, {
          method: testCase.method,
          url: testCase.url,
          session,
          ...(testCase.payload === undefined ? {} : { payload: testCase.payload }),
        });

        expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(404);
        expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
      }

      expect(
        (
          await authedRequest(app, {
            method: 'GET',
            url: '/api/v1/tenants/missing-tenant',
            session,
          })
        ).statusCode,
      ).toBe(404);

      // foreign 成员未受影响。
      expect(
        (await new MembershipRepository(database.db, tenantB.id).find(foreignMember.id))?.role,
      ).toBe('viewer');
      expect((await new MembershipRepository(database.db, tenantA.id).find(owner.id))?.userId).toBe(
        owner.id,
      );
      expect(
        (
          await authedRequest(app, {
            method: 'POST',
            url: '/api/v1/me/active-tenant',
            session,
            payload: { tenantId: tenantB.id },
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('returns 404 for cross-tenant requests even when the role lacks permission', async () => {
    await withApp(async ({ app, database }) => {
      const tenantA = await seedTenant(database.db, 'tenant-a');
      const tenantB = await seedTenant(database.db, 'tenant-b');
      const developer = await seedUser(database.db, {
        username: 'developer',
        tenantId: tenantA.id,
        role: 'developer',
      });
      await new MembershipRepository(database.db, tenantB.id).add({
        userId: developer.id,
        role: 'developer',
        status: MEMBER_STATUS.ACTIVE,
        now: Date.now() + 10_000,
      });

      const session = await login(app, 'developer', TEST_PASSWORD);

      for (const url of [
        `/api/v1/tenants/${tenantB.id}`,
        `/api/v1/tenants/${tenantB.id}/members`,
      ]) {
        const response = await authedRequest(app, { method: 'GET', url, session });

        expect(response.statusCode, url).toBe(404);
        expect((response.json() as { code: string }).code).toBe('NOT_FOUND');
      }
    });
  });

  it('only exposes tenants the user belongs to and audits switches in the target tenant', async () => {
    await withApp(async ({ app, database }) => {
      const tenantA = await seedTenant(database.db, 'tenant-a');
      const tenantB = await seedTenant(database.db, 'tenant-b');
      const user = await seedUser(database.db, {
        username: 'multi',
        tenantId: tenantA.id,
        role: 'owner',
      });
      await new MembershipRepository(database.db, tenantB.id).add({
        userId: user.id,
        role: 'admin',
        status: MEMBER_STATUS.ACTIVE,
        now: Date.now() + 10_000,
      });

      const session = await login(app, 'multi', TEST_PASSWORD);

      const tenants = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me/tenants',
        session,
      });
      expect((tenants.json() as { items: Array<{ id: string }> }).items).toHaveLength(2);

      const switched = await authedRequest(app, {
        method: 'POST',
        url: '/api/v1/me/active-tenant',
        session,
        payload: { tenantId: tenantB.id },
      });
      const switchedBody = switched.json() as {
        activeTenant: { id: string; role: string };
        permissions: string[];
      };
      expect(switched.statusCode).toBe(200);
      expect(switchedBody.activeTenant.id).toBe(tenantB.id);
      expect(switchedBody.activeTenant.role).toBe('admin');
      expect(switchedBody.permissions).not.toContain('tenant:update');

      expect(
        (
          await authedRequest(app, {
            method: 'GET',
            url: `/api/v1/tenants/${tenantA.id}`,
            session,
          })
        ).statusCode,
      ).toBe(404);

      expect(
        (
          await authedRequest(app, {
            method: 'GET',
            url: `/api/v1/tenants/${tenantB.id}`,
            session,
          })
        ).statusCode,
      ).toBe(200);

      const auditB = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs',
        session,
      });
      const auditBody = auditB.json() as {
        items: Array<{ action: string; tenantId: string }>;
      };
      expect(auditBody.items.length).toBeGreaterThan(0);
      expect(auditBody.items.every((item) => item.tenantId === tenantB.id)).toBe(true);
      expect(auditBody.items.map((item) => item.action)).toContain('tenant.switch');
      expect(auditBody.items.map((item) => item.action)).not.toContain('auth.login.success');
    });
  });
});

describe('CSRF protection', () => {
  it('rejects missing, mismatched and forged CSRF tokens', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
      const session = await login(app, 'owner', TEST_PASSWORD);

      const noHeader = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me/password',
        payload: { currentPassword: TEST_PASSWORD, newPassword: 'another-password-123' },
        headers: { cookie: cookieHeader(session.cookies) },
      });
      expect(noHeader.statusCode).toBe(403);

      const mismatched = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me/password',
        payload: { currentPassword: TEST_PASSWORD, newPassword: 'another-password-123' },
        headers: {
          cookie: cookieHeader(session.cookies),
          [CSRF_HEADER_NAME]: 'forged.token',
        },
      });
      expect(mismatched.statusCode).toBe(403);

      const forgedCookies = new Map(session.cookies);
      forgedCookies.set(CSRF_COOKIE_NAME, 'forged.token');
      const forged = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          cookie: cookieHeader(forgedCookies),
          [CSRF_HEADER_NAME]: 'forged.token',
        },
      });
      expect(forged.statusCode).toBe(403);

      const safeRequest = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(session.cookies) },
      });
      expect(safeRequest.statusCode).toBe(200);
    });
  });

  it('issues a CSRF cookie on safe API requests when missing', async () => {
    await withApp(async ({ app }) => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
      const setCookie = response.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie ?? '');

      expect(header).toContain(`${CSRF_COOKIE_NAME}=`);
    });
  });
});

describe('login throttling', () => {
  it('returns 429 after repeated failures and does not issue a session', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
      const csrf = await bootstrapCsrf(app);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(app, 'owner', 'wrong-password', csrf);
      }

      const limited = await login(app, 'owner', TEST_PASSWORD, csrf);
      expect(limited.response.statusCode).toBe(429);
      expect(limited.cookies.get('gait_session')).toBeUndefined();
    });
  });
});
