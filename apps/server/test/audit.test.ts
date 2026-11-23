// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { MembershipRepository } from '@gait/db';
import { AUDIT_ACTION, MEMBER_STATUS } from '@gait/shared';
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

interface AuditItem {
  id: string;
  tenantId: string;
  actorUsername: string | null;
  action: string;
  resourceType: string | null;
  detailJson: string;
  createdAt: string;
}

describe('audit logs', () => {
  it('records login, failures, member changes and tenant switches', async () => {
    await withApp(async ({ app, database }) => {
      const tenantA = await seedTenant(database.db, 'tenant-a');
      const tenantB = await seedTenant(database.db, 'tenant-b');
      const owner = await seedUser(database.db, {
        username: 'owner',
        tenantId: tenantA.id,
        role: 'owner',
      });
      await seedUser(database.db, { username: 'victim', tenantId: tenantA.id, role: 'viewer' });
      await new MembershipRepository(database.db, tenantB.id).add({
        userId: owner.id,
        role: 'admin',
        status: MEMBER_STATUS.ACTIVE,
        now: Date.now() + 10_000,
      });

      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      await login(app, 'victim', 'wrong-password');

      const renamed = await authedRequest(app, {
        method: 'PATCH',
        url: `/api/v1/tenants/${tenantA.id}`,
        session: ownerSession,
        payload: { name: 'Acme Renamed' },
      });
      expect(renamed.statusCode).toBe(200);

      const added = await authedRequest(app, {
        method: 'POST',
        url: `/api/v1/tenants/${tenantA.id}/members`,
        session: ownerSession,
        payload: {
          username: 'audited-newbie',
          role: 'developer',
          password: 'audited-password-1',
        },
      });
      expect(added.statusCode).toBe(201);

      const firstPage = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs?limit=2',
        session: ownerSession,
      });
      const firstBody = firstPage.json() as { items: AuditItem[]; nextCursor: string | null };
      expect(firstPage.statusCode).toBe(200);
      expect(firstBody.items).toHaveLength(2);
      expect(firstBody.nextCursor).not.toBeNull();
      expect(firstBody.items[0]?.createdAt).toMatch(/Z$/);

      const collected: AuditItem[] = [...firstBody.items];
      let cursor = firstBody.nextCursor;

      while (cursor !== null) {
        const page = await authedRequest(app, {
          method: 'GET',
          url: `/api/v1/audit-logs?limit=2&cursor=${encodeURIComponent(cursor)}`,
          session: ownerSession,
        });
        const body = page.json() as { items: AuditItem[]; nextCursor: string | null };
        collected.push(...body.items);
        cursor = body.nextCursor;
      }

      const actions = collected.map((item) => item.action);
      expect(new Set(collected.map((item) => item.id)).size).toBe(collected.length);
      expect(actions).toContain(AUDIT_ACTION.LOGIN_SUCCESS);
      expect(actions).toContain(AUDIT_ACTION.LOGIN_FAILURE);
      expect(actions).toContain(AUDIT_ACTION.TENANT_UPDATE);
      expect(actions).toContain(AUDIT_ACTION.MEMBER_ADD);
      expect(collected.every((item) => item.tenantId === tenantA.id)).toBe(true);

      const memberAudit = collected.find((item) => item.action === AUDIT_ACTION.MEMBER_ADD);
      expect(memberAudit?.actorUsername).toBe('owner');
      expect(memberAudit?.detailJson).toContain('audited-newbie');

      const filtered = await authedRequest(app, {
        method: 'GET',
        url: `/api/v1/audit-logs?action=${encodeURIComponent(AUDIT_ACTION.MEMBER_ADD)}`,
        session: ownerSession,
      });
      expect((filtered.json() as { items: AuditItem[] }).items).toHaveLength(1);

      const byResource = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs?resourceType=tenant_member',
        session: ownerSession,
      });
      expect((byResource.json() as { items: AuditItem[] }).items.length).toBeGreaterThan(0);

      const switched = await authedRequest(app, {
        method: 'POST',
        url: '/api/v1/me/active-tenant',
        session: ownerSession,
        payload: { tenantId: tenantB.id },
      });
      expect(switched.statusCode).toBe(200);

      const tenantBAudit = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs',
        session: ownerSession,
      });
      const tenantBItems = (tenantBAudit.json() as { items: AuditItem[] }).items;
      expect(tenantBItems.map((item) => item.action)).toEqual([AUDIT_ACTION.TENANT_SWITCH]);
      expect(tenantBItems[0]?.tenantId).toBe(tenantB.id);
      expect(tenantBItems[0]?.detailJson).toContain(tenantA.id);
    });
  });

  it('rejects invalid audit queries and users without audit:read', async () => {
    await withApp(async ({ app, database }) => {
      const tenant = await seedTenant(database.db);
      await seedUser(database.db, { username: 'owner', tenantId: tenant.id, role: 'owner' });
      await seedUser(database.db, { username: 'viewer', tenantId: tenant.id, role: 'viewer' });

      const ownerSession = await login(app, 'owner', TEST_PASSWORD);
      const viewerSession = await login(app, 'viewer', TEST_PASSWORD);

      const forbidden = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs',
        session: viewerSession,
      });
      expect(forbidden.statusCode).toBe(403);

      const badCursor = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs?cursor=not-valid',
        session: ownerSession,
      });
      expect(badCursor.statusCode).toBe(400);

      const badAction = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs?action=not-an-action',
        session: ownerSession,
      });
      expect(badAction.statusCode).toBe(400);

      const badLimit = await authedRequest(app, {
        method: 'GET',
        url: '/api/v1/audit-logs?limit=500',
        session: ownerSession,
      });
      expect(badLimit.statusCode).toBe(400);
    });
  });
});
