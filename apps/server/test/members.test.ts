// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { TenantAuditLogRepository, UserRepository } from '@gait/db';
import { AUDIT_ACTION, USER_STATUS } from '@gait/shared';
import type { TenantRole } from '@gait/shared';
import {
  authedRequest,
  closeTestApp,
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

interface MemberBody {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface MemberListBody {
  items: MemberBody[];
}

describe('tenant member management', () => {
  it('enforces the RBAC matrix on tenant, member and audit endpoints', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = seedTenant(database.db);
      const roles: TenantRole[] = ['owner', 'admin', 'developer', 'viewer'];
      const sessions = new Map<TenantRole, Awaited<ReturnType<typeof login>>>();

      for (const role of roles) {
        await seedUser(database.db, { username: role, tenantId: tenant.id, role });
        sessions.set(role, await login(app, role, TEST_PASSWORD));
      }

      const owner = sessions.get('owner');
      const admin = sessions.get('admin');
      const developer = sessions.get('developer');
      const viewer = sessions.get('viewer');
      expect(owner && admin && developer && viewer).toBeTruthy();

      if (
        owner === undefined ||
        admin === undefined ||
        developer === undefined ||
        viewer === undefined
      ) {
        return;
      }

      const tenantUrl = `/api/v1/tenants/${tenant.id}`;
      const membersUrl = `${tenantUrl}/members`;
      const auditUrl = '/api/v1/audit-logs';

      for (const session of [owner, admin, developer, viewer]) {
        const readTenant = await authedRequest(app, {
          method: 'GET',
          url: tenantUrl,
          session,
        });
        expect(readTenant.statusCode).toBe(200);
      }

      for (const session of [developer, viewer]) {
        expect(
          (await authedRequest(app, { method: 'GET', url: membersUrl, session })).statusCode,
        ).toBe(403);
        expect(
          (await authedRequest(app, { method: 'GET', url: auditUrl, session })).statusCode,
        ).toBe(403);
      }

      expect(
        (await authedRequest(app, { method: 'GET', url: membersUrl, session: admin })).statusCode,
      ).toBe(200);
      expect(
        (await authedRequest(app, { method: 'GET', url: auditUrl, session: admin })).statusCode,
      ).toBe(200);

      for (const session of [admin, developer, viewer]) {
        const patch = await authedRequest(app, {
          method: 'PATCH',
          url: tenantUrl,
          session,
          payload: { name: 'Renamed' },
        });
        expect(patch.statusCode).toBe(403);
      }

      const renamed = await authedRequest(app, {
        method: 'PATCH',
        url: tenantUrl,
        session: owner,
        payload: { name: 'Renamed' },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as { tenant: { name: string } }).tenant.name).toBe('Renamed');

      const added = await authedRequest(app, {
        method: 'POST',
        url: membersUrl,
        session: admin,
        payload: {
          username: 'new-viewer',
          role: 'viewer',
          password: 'new-viewer-password-1',
        },
      });
      expect(added.statusCode).toBe(201);
      expect((added.json() as { member: MemberBody }).member.role).toBe('viewer');

      const deniedAudits = new TenantAuditLogRepository(database.db, tenant.id).list({
        action: AUDIT_ACTION.AUTHORIZATION_DENIED,
      });
      expect(deniedAudits.items.length).toBeGreaterThanOrEqual(4);
      expect(deniedAudits.items[0]?.actorUsername).not.toBeNull();
    });
  });

  it('runs the member lifecycle and revokes sessions on removal', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = seedTenant(database.db);
      const owner = await seedUser(database.db, {
        username: 'owner',
        tenantId: tenant.id,
        role: 'owner',
      });
      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      const membersUrl = `/api/v1/tenants/${tenant.id}/members`;

      const created = await authedRequest(app, {
        method: 'POST',
        url: membersUrl,
        session: ownerSession,
        payload: {
          username: 'developer',
          role: 'developer',
          password: 'developer-password-1',
          displayName: 'Dev One',
          email: 'dev@example.com',
        },
      });
      const createdBody = created.json() as { member: MemberBody };
      expect(created.statusCode).toBe(201);
      expect(createdBody.member.displayName).toBe('Dev One');
      expect(createdBody.member.email).toBe('dev@example.com');
      expect(createdBody.member.lastLoginAt).toBeNull();
      expect(createdBody.member.createdAt).toMatch(/Z$/);

      const developerSession = await login(app, 'developer', 'developer-password-1');
      const developerMe = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: developerSession,
      });
      expect((developerMe.json() as { activeTenant: { role: string } }).activeTenant.role).toBe(
        'developer',
      );

      const renamedRole = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/${createdBody.member.userId}`,
        session: ownerSession,
        payload: { role: 'viewer' },
      });
      expect(renamedRole.statusCode).toBe(200);
      expect((renamedRole.json() as { member: MemberBody }).member.role).toBe('viewer');

      const viewerMe = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: developerSession,
      });
      expect((viewerMe.json() as { activeTenant: { role: string } }).activeTenant.role).toBe(
        'viewer',
      );

      const removed = await authedRequest(app, {
        method: 'DELETE',
        url: `${membersUrl}/${createdBody.member.userId}`,
        session: ownerSession,
      });
      expect(removed.statusCode).toBe(204);

      expect(
        (
          await authedRequest(app, {
            method: 'GET',
            url: '/api/v1/me',
            session: developerSession,
          })
        ).statusCode,
      ).toBe(401);

      const list = await authedRequest(app, {
        method: 'GET',
        url: membersUrl,
        session: ownerSession,
      });
      const listBody = list.json() as MemberListBody;
      expect(listBody.items.map((item) => item.username)).toEqual(['owner']);
      expect(listBody.items[0]?.userId).toBe(owner.id);

      const logins = await login(app, 'developer', 'developer-password-1');
      expect(logins.response.statusCode).toBe(401);

      const audits = new TenantAuditLogRepository(database.db, tenant.id).list();
      const actions = audits.items.map((item) => item.action);
      expect(actions).toContain(AUDIT_ACTION.MEMBER_ADD);
      expect(actions).toContain(AUDIT_ACTION.MEMBER_ROLE_UPDATE);
      expect(actions).toContain(AUDIT_ACTION.MEMBER_REMOVE);
    });
  });

  it('protects the last owner and restricts owner management to owners', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = seedTenant(database.db);
      const owner = await seedUser(database.db, {
        username: 'owner',
        tenantId: tenant.id,
        role: 'owner',
      });
      await seedUser(database.db, { username: 'admin', tenantId: tenant.id, role: 'admin' });
      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      const adminSession = await login(app, 'admin', TEST_PASSWORD);
      const membersUrl = `/api/v1/tenants/${tenant.id}/members`;

      const selfDemote = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/${owner.id}`,
        session: ownerSession,
        payload: { role: 'admin' },
      });
      expect(selfDemote.statusCode).toBe(409);
      expect((selfDemote.json() as { detail: string }).detail).toContain('at least one');

      const selfRemove = await authedRequest(app, {
        method: 'DELETE',
        url: `${membersUrl}/${owner.id}`,
        session: ownerSession,
      });
      expect(selfRemove.statusCode).toBe(409);

      const adminAddsOwner = await authedRequest(app, {
        method: 'POST',
        url: membersUrl,
        session: adminSession,
        payload: {
          username: 'owner-two',
          role: 'owner',
          password: 'owner-two-password-1',
        },
      });
      expect(adminAddsOwner.statusCode).toBe(403);

      const ownerAddsOwner = await authedRequest(app, {
        method: 'POST',
        url: membersUrl,
        session: ownerSession,
        payload: {
          username: 'owner-two',
          role: 'owner',
          password: 'owner-two-password-1',
        },
      });
      const secondOwner = (ownerAddsOwner.json() as { member: MemberBody }).member;
      expect(ownerAddsOwner.statusCode).toBe(201);
      expect(secondOwner.role).toBe('owner');

      const adminEditsOwner = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/${secondOwner.userId}`,
        session: adminSession,
        payload: { role: 'viewer' },
      });
      expect(adminEditsOwner.statusCode).toBe(403);

      const adminRemovesOwner = await authedRequest(app, {
        method: 'DELETE',
        url: `${membersUrl}/${secondOwner.userId}`,
        session: adminSession,
      });
      expect(adminRemovesOwner.statusCode).toBe(403);

      const demoteSelf = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/${owner.id}`,
        session: ownerSession,
        payload: { role: 'admin' },
      });
      expect(demoteSelf.statusCode).toBe(200);
      expect((demoteSelf.json() as { member: MemberBody }).member.role).toBe('admin');

      const escalation = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/${secondOwner.userId}`,
        session: ownerSession,
        payload: { role: 'viewer' },
      });
      expect(escalation.statusCode).toBe(403);
    });
  });

  it('validates new member input and membership conflicts', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = seedTenant(database.db);
      await seedUser(database.db, {
        username: 'owner',
        tenantId: tenant.id,
        role: 'owner',
        email: 'taken@example.com',
      });
      await seedUser(database.db, {
        username: 'suspended',
        tenantId: tenant.id,
        role: 'viewer',
        status: USER_STATUS.SUSPENDED,
      });
      await seedUser(database.db, { username: 'existing', tenantId: tenant.id, role: 'viewer' });

      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      const membersUrl = `/api/v1/tenants/${tenant.id}/members`;
      const add = async (payload: Record<string, unknown>) =>
        authedRequest(app, { method: 'POST', url: membersUrl, session: ownerSession, payload });

      expect((await add({ username: 'existing', role: 'viewer' })).statusCode).toBe(409);
      expect((await add({ username: 'needs-password', role: 'viewer' })).statusCode).toBe(400);
      expect((await add({ username: 'weak', role: 'viewer', password: 'short' })).statusCode).toBe(
        400,
      );
      expect(
        (await add({ username: 'Bad Name', role: 'viewer', password: 'valid-password-123' }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await add({
            username: 'duplicate-email',
            role: 'viewer',
            password: 'valid-password-123',
            email: 'taken@example.com',
          })
        ).statusCode,
      ).toBe(409);
      expect((await add({ username: 'suspended', role: 'viewer' })).statusCode).toBe(409);
      expect(
        (await add({ username: 'bad-role', role: 'superuser', password: 'valid-password-123' }))
          .statusCode,
      ).toBe(400);

      const missing = await authedRequest(app, {
        method: 'PATCH',
        url: `${membersUrl}/missing-user`,
        session: ownerSession,
        payload: { role: 'viewer' },
      });
      expect(missing.statusCode).toBe(404);

      const missingDelete = await authedRequest(app, {
        method: 'DELETE',
        url: `${membersUrl}/missing-user`,
        session: ownerSession,
      });
      expect(missingDelete.statusCode).toBe(404);

      const existingUser = new UserRepository(database.db).findByUsername('existing');

      if (existingUser !== undefined) {
        const sameRole = await authedRequest(app, {
          method: 'PATCH',
          url: `${membersUrl}/${existingUser.id}`,
          session: ownerSession,
          payload: { role: 'viewer' },
        });
        expect(sameRole.statusCode).toBe(200);
      }
    });
  });

  it('adds an existing user from another tenant without a password', async () => {
    await withApp(async ({ app, database }) => {
      const tenantA = seedTenant(database.db, 'tenant-a');
      const tenantB = seedTenant(database.db, 'tenant-b');
      await seedUser(database.db, { username: 'owner', tenantId: tenantA.id, role: 'owner' });
      const outsider = await seedUser(database.db, {
        username: 'outsider',
        tenantId: tenantB.id,
        role: 'admin',
      });

      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      const added = await authedRequest(app, {
        method: 'POST',
        url: `/api/v1/tenants/${tenantA.id}/members`,
        session: ownerSession,
        payload: { username: 'outsider', role: 'developer' },
      });

      expect(added.statusCode).toBe(201);
      expect((added.json() as { member: MemberBody }).member.userId).toBe(outsider.id);

      const outsiderSession = await login(app, 'outsider', TEST_PASSWORD);
      const me = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me',
        session: outsiderSession,
      });
      expect((me.json() as { activeTenant: { id: string } }).activeTenant.id).toBe(tenantB.id);

      const tenants = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/me/tenants',
        session: outsiderSession,
      });
      expect((tenants.json() as { items: unknown[] }).items).toHaveLength(2);
    });
  });
});
