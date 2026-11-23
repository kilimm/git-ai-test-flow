// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { hashPassword } from '@gait/config';
import {
  createPlatformAdmin,
  SessionRepository,
  TenantAuditLogRepository,
  UserRepository,
} from '@gait/db';
import { AUDIT_ACTION, SESSION_COOKIE_NAME, USER_STATUS } from '@gait/shared';
import { hashSessionToken } from '../src/auth/session-token.js';
import { CSRF_HEADER_NAME } from '../src/csrf.js';
import {
  authedRequest,
  bootstrapCsrf,
  closeTestApp,
  cookieHeader,
  createTestApp,
  login,
  mergeCookies,
  seedTenant,
  seedUser,
  sessionCookieOf,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';

async function withApp(
  run: (context: TestAppContext) => Promise<void>,
  options: { now?: () => number } = {},
): Promise<void> {
  const context = await createTestApp(options);

  try {
    await run(context);
  } finally {
    await closeTestApp(context);
  }
}

function setCookiesOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const values = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];

  return values.join('\n');
}

describe('auth API', () => {
  it('logs in, returns the session summary and sets secure cookie attributes', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });

      const result = await login(app, 'owner', TEST_PASSWORD);
      const body = result.response.json() as {
        user: { username: string; displayName: string };
        activeTenant: { id: string; slug: string; role: string };
        tenants: unknown[];
        permissions: string[];
      };

      expect(result.response.statusCode).toBe(200);
      expect(body.user.username).toBe('owner');
      expect(body.activeTenant.id).toBe(tenant.id);
      expect(body.activeTenant.role).toBe('owner');
      expect(body.tenants).toHaveLength(1);
      expect(body.permissions).toContain('tenant:member:manage');
      expect(body.permissions).toContain('tenant:update');

      const cookies = setCookiesOf(result.response);
      expect(cookies).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookies).toContain('HttpOnly');
      expect(cookies).toContain('SameSite=Lax');
      expect(cookies).toContain('Path=/');
      expect(cookies).not.toContain('Secure');

      const me = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: result,
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { user: { username: string } }).user.username).toBe('owner');

      const audits = await new TenantAuditLogRepository(database.db, tenant.id).list();
      expect(audits.items[0]?.action).toBe(AUDIT_ACTION.LOGIN_SUCCESS);
    });
  });

  it('logs in the platform administrator created by the admin CLI core', async () => {
    await withApp(async ({ app, database }) => {
      const created = await createPlatformAdmin(database.db, {
        username: 'root',
        password: 'cli-admin-password-1',
        tenantSlug: 'cli-workspace',
        tenantName: 'CLI Workspace',
      });

      const result = await login(app, 'root', 'cli-admin-password-1');
      const body = result.response.json() as {
        user: { isPlatformAdmin: boolean };
        activeTenant: { id: string; role: string };
      };

      expect(result.response.statusCode).toBe(200);
      expect(body.user.isPlatformAdmin).toBe(true);
      expect(body.activeTenant.id).toBe(created.tenant.id);
      expect(body.activeTenant.role).toBe('owner');
    });
  });

  it('marks the session cookie Secure in production', async () => {
    const context = await createTestApp({ envOverrides: { NODE_ENV: 'production' } });

    try {
      const tenant = await seedTenant(context.database.db);
      await seedUser(context.database.db, {
        username: 'owner',
        tenantId: tenant.id,
        role: 'owner',
      });

      const result = await login(context.app, 'owner', TEST_PASSWORD);

      expect(result.response.statusCode).toBe(200);
      expect(setCookiesOf(result.response)).toContain('Secure');
    } finally {
      await closeTestApp(context);
    }
  });

  it('rejects bad CSRF tokens and bad credentials without issuing a session', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });

      const blocked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'owner', password: TEST_PASSWORD },
      });
      expect(blocked.statusCode).toBe(403);
      expect((blocked.json() as { code: string }).code).toBe('FORBIDDEN');

      const csrf = await bootstrapCsrf(app);
      const mismatched = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'owner', password: TEST_PASSWORD },
        headers: {
          cookie: cookieHeader(csrf.cookies),
          [CSRF_HEADER_NAME]: 'invalid.token',
        },
      });
      expect(mismatched.statusCode).toBe(403);

      const wrongPassword = await login(app, 'owner', 'wrong-password', csrf);
      expect(wrongPassword.response.statusCode).toBe(401);
      expect((wrongPassword.response.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
      expect(sessionCookieOf(wrongPassword.cookies)).toBeUndefined();

      const unknownUser = await login(app, 'nobody', 'wrong-password', csrf);
      expect(unknownUser.response.statusCode).toBe(401);
      expect((unknownUser.response.json() as { detail: string }).detail).toBe(
        'Invalid username or password',
      );

      const failures = await new TenantAuditLogRepository(database.db, tenant.id).list({
        action: AUDIT_ACTION.LOGIN_FAILURE,
      });
      expect(failures.items).toHaveLength(1);
      expect(failures.items[0]?.detailJson).toContain('invalid_credentials');

      const totalFailures = await database.pglite.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM audit_logs WHERE action = $1',
        [AUDIT_ACTION.LOGIN_FAILURE],
      );
      expect(totalFailures.rows[0]?.count).toBe(2);
    });
  });

  it('rejects suspended users and users without an active tenant', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, {
        username: 'suspended',
        tenantId: tenant.id,
        role: 'owner',
        status: USER_STATUS.SUSPENDED,
      });
      await new UserRepository(database.db).create({
        username: 'lonely',
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: 'Lonely',
      });

      const suspended = await login(app, 'suspended', TEST_PASSWORD);
      expect(suspended.response.statusCode).toBe(401);
      expect((suspended.response.json() as { detail: string }).detail).toBe(
        'Account is not available',
      );

      const lonely = await login(app, 'lonely', TEST_PASSWORD);
      expect(lonely.response.statusCode).toBe(401);
      expect((lonely.response.json() as { detail: string }).detail).toBe(
        'Account has no active tenant',
      );
    });
  });

  it('logs out idempotently and revokes the session', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
      const session = await login(app, 'owner', TEST_PASSWORD);

      const logout = await authedRequest(app, {
        method: 'POST',
        url: '/api/v1/auth/logout',
        session,
      });
      expect(logout.statusCode).toBe(204);

      const me = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session,
      });
      expect(me.statusCode).toBe(401);
      expect((me.json() as { code: string }).code).toBe('AUTH_REQUIRED');

      const secondLogout = await authedRequest(app, {
        method: 'POST',
        url: '/api/v1/auth/logout',
        session,
      });
      expect(secondLogout.statusCode).toBe(204);

      const audits = await new TenantAuditLogRepository(database.db, tenant.id).list();
      expect(audits.items.some((item) => item.action === AUDIT_ACTION.LOGOUT)).toBe(true);
    });
  });

  it('changes the password, revokes other sessions and requires the new password', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
      const first = await login(app, 'owner', TEST_PASSWORD);
      const second = await login(app, 'owner', TEST_PASSWORD);
      const newPassword = 'brand-new-password-456';

      const wrongCurrent = await authedRequest(app, {
        method: 'PATCH',
        url: '/api/v1/me/password',
        session: first,
        payload: { currentPassword: 'wrong-password', newPassword },
      });
      expect(wrongCurrent.statusCode).toBe(401);

      const weak = await authedRequest(app, {
        method: 'PATCH',
        url: '/api/v1/me/password',
        session: first,
        payload: { currentPassword: TEST_PASSWORD, newPassword: 'short' },
      });
      expect(weak.statusCode).toBe(400);

      const same = await authedRequest(app, {
        method: 'PATCH',
        url: '/api/v1/me/password',
        session: first,
        payload: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
      });
      expect(same.statusCode).toBe(400);

      const changed = await authedRequest(app, {
        method: 'PATCH',
        url: '/api/v1/me/password',
        session: first,
        payload: { currentPassword: TEST_PASSWORD, newPassword },
      });
      expect(changed.statusCode).toBe(204);

      expect(
        (await authedRequest(app, { method: 'GET', url: '/api/v1/me', session: first })).statusCode,
      ).toBe(200);

      const revoked = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: second,
      });
      expect(revoked.statusCode).toBe(401);

      expect((await login(app, 'owner', TEST_PASSWORD)).response.statusCode).toBe(401);
      expect((await login(app, 'owner', newPassword)).response.statusCode).toBe(200);

      const audits = await new TenantAuditLogRepository(database.db, tenant.id).list({
        action: AUDIT_ACTION.PASSWORD_CHANGE,
      });
      expect(audits.items).toHaveLength(1);
    });
  });

  it('expires sessions by idle time and absolute lifetime', async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };

    await withApp(
      async ({ app, database }) => {
        const tenant = await seedTenant(database.db);
        await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });

        const idleSession = await login(app, 'owner', TEST_PASSWORD);
        clock.now += 24 * 60 * 60 * 1_000 + 1;

        const idle = await authedRequest(app, {
          method: 'GET',
          url: '/api/v1/me',
          session: idleSession,
        });
        expect(idle.statusCode).toBe(401);

        const absoluteSession = await login(app, 'owner', TEST_PASSWORD);
        const token = sessionCookieOf(absoluteSession.cookies);
        expect(token).toBeDefined();

        if (token !== undefined) {
          const sessions = new SessionRepository(database.db);
          const stored = await sessions.findByTokenHash(hashSessionToken(token));
          expect(stored).toBeDefined();

          if (stored !== undefined) {
            await database.pglite.query(
              'UPDATE sessions SET expires_at = $1, last_seen_at = $2 WHERE id = $3',
              [clock.now - 1, clock.now, stored.id],
            );
          }
        }

        const absolute = await authedRequest(app, {
          method: 'GET',
          url: '/api/v1/me',
          session: absoluteSession,
        });
        expect(absolute.statusCode).toBe(401);
      },
      { now: () => clock.now },
    );
  });

  it('rotates the session token on re-login to prevent session fixation', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });

      const first = await login(app, 'owner', TEST_PASSWORD);
      const firstToken = sessionCookieOf(first.cookies);
      const second = await login(app, 'owner', TEST_PASSWORD, first);
      const secondToken = sessionCookieOf(second.cookies);

      expect(firstToken).toBeDefined();
      expect(secondToken).toBeDefined();
      expect(firstToken).not.toBe(secondToken);

      const oldSession = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: first,
      });
      expect(oldSession.statusCode).toBe(401);

      const newSession = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: second,
      });
      expect(newSession.statusCode).toBe(200);
    });
  });

  it('rate limits repeated failures per IP and username and resets after success', async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };

    await withApp(
      async ({ app, database }) => {
        const tenant = await seedTenant(database.db);
        await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
        await seedUser(database.db, { username: 'other', tenantId: tenant.id, role: 'viewer' });

        const csrf = await bootstrapCsrf(app);

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const failed = await login(app, 'owner', 'wrong-password', csrf);
          expect(failed.response.statusCode).toBe(401);
        }

        const limited = await login(app, 'owner', TEST_PASSWORD, csrf);
        expect(limited.response.statusCode).toBe(429);
        expect((limited.response.json() as { code: string }).code).toBe('RATE_LIMITED');

        const otherUser = await login(app, 'other', TEST_PASSWORD, csrf);
        expect(otherUser.response.statusCode).toBe(200);

        clock.now += 15 * 60 * 1_000 + 1;

        const afterWindow = await login(app, 'owner', TEST_PASSWORD, csrf);
        expect(afterWindow.response.statusCode).toBe(200);

        const successCsrf = await bootstrapCsrf(app);
        await login(app, 'owner', 'wrong-password', successCsrf);
        const success = await login(app, 'owner', TEST_PASSWORD, successCsrf);
        expect(success.response.statusCode).toBe(200);
      },
      { now: () => clock.now },
    );
  });

  it('rejects unauthenticated access and keeps CSRF cookie fresh', async () => {
    await withApp(async ({ app }) => {
      const me = await app.inject({ method: 'GET', url: '/api/v1/me' });
      expect(me.statusCode).toBe(401);
      expect((me.json() as { code: string }).code).toBe('AUTH_REQUIRED');

      const csrfResponse = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
      const body = csrfResponse.json() as { csrfToken: string };
      expect(body.csrfToken).toContain('.');
      expect(setCookiesOf(csrfResponse)).toContain('gait_csrf=');

      const cookies = mergeCookies(csrfResponse);
      const withSessionCookie = new Map(cookies);
      withSessionCookie.set(SESSION_COOKIE_NAME, 'x'.repeat(43));
      const invalid = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(withSessionCookie) },
      });
      expect(invalid.statusCode).toBe(401);
    });
  });
});
