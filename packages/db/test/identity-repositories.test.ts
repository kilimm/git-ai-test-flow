// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@gait/config';
import {
  AuditLogWriter,
  MembershipAccessRepository,
  MembershipRepository,
  SessionRepository,
  TenantAuditLogRepository,
  TenantRepository,
  UserRepository,
} from '../src/index.js';
import type { AppDatabase } from '../src/client.js';
import { createTestDatabase } from '../src/testing.js';

async function seedUser(db: AppDatabase, id: string, username = id): Promise<void> {
  await new UserRepository(db).create({
    id,
    username,
    passwordHash: '$argon2id$fake',
    displayName: username,
    now: 1,
  });
}

async function seedTenant(db: AppDatabase, id: string, slug = id): Promise<void> {
  await new TenantRepository(db).create({ id, slug, name: slug, now: 1 });
}

describe('UserRepository', () => {
  it('creates, finds and updates users', async () => {
    const database = await createTestDatabase();

    try {
      const repository = new UserRepository(database.db);
      const user = await repository.create({
        id: 'user-1',
        username: 'alice',
        email: 'alice@example.com',
        passwordHash: '$argon2id$fake',
        displayName: 'Alice',
        now: 10,
      });

      expect(user.createdAt).toBe(10);
      expect(await repository.findById('user-1')).toEqual(user);
      expect(await repository.findByUsername('alice')).toEqual(user);
      expect(await repository.findByEmail('alice@example.com')).toEqual(user);

      expect(await repository.updatePasswordHash('user-1', '$argon2id$new', 20)).toBe(true);
      expect((await repository.findById('user-1'))?.passwordHash).toBe('$argon2id$new');

      await repository.recordLogin('user-1', 30);
      expect((await repository.findById('user-1'))?.lastLoginAt).toBe(30);

      expect(await repository.updatePasswordHash('missing', '$argon2id$new', 40)).toBe(false);
      expect(await repository.findById('missing')).toBeUndefined();
    } finally {
      await database.cleanup();
    }
  });

  it('counts platform administrators', async () => {
    const database = await createTestDatabase();

    try {
      const repository = new UserRepository(database.db);
      await seedUser(database.db, 'user-1');
      await repository.create({
        id: 'user-2',
        username: 'root',
        passwordHash: '$argon2id$fake',
        displayName: 'Root',
        isPlatformAdmin: true,
      });

      expect(await repository.countPlatformAdmins()).toBe(1);
    } finally {
      await database.cleanup();
    }
  });
});

describe('TenantRepository', () => {
  it('creates by slug and updates the name', async () => {
    const database = await createTestDatabase();

    try {
      const repository = new TenantRepository(database.db);
      const tenant = await repository.create({
        id: 'tenant-1',
        slug: 'acme',
        name: 'Acme',
        now: 5,
      });

      expect(await repository.findBySlug('acme')).toEqual(tenant);
      expect(await repository.findById('tenant-1')).toEqual(tenant);
      expect(await repository.updateName('tenant-1', 'Acme Corp', 6)).toBe(true);
      expect((await repository.findById('tenant-1'))?.name).toBe('Acme Corp');
      expect(await repository.updateName('missing', 'Nope', 7)).toBe(false);
    } finally {
      await database.cleanup();
    }
  });
});

describe('MembershipRepository tenant isolation', () => {
  it('only sees and mutates members of the scoped tenant', async () => {
    const database = await createTestDatabase();

    try {
      await seedUser(database.db, 'user-1', 'alice');
      await seedTenant(database.db, 'tenant-a', 'tenant-a');
      await seedTenant(database.db, 'tenant-b', 'tenant-b');

      const tenantA = new MembershipRepository(database.db, 'tenant-a');
      const tenantB = new MembershipRepository(database.db, 'tenant-b');

      await tenantA.add({ userId: 'user-1', role: 'owner', now: 10 });
      await tenantB.add({ userId: 'user-1', role: 'viewer', now: 11 });

      expect(await tenantA.list()).toHaveLength(1);
      expect((await tenantA.list())[0]?.role).toBe('owner');
      expect((await tenantB.list())[0]?.role).toBe('viewer');
      expect((await tenantA.find('user-1'))?.role).toBe('owner');

      // 通过 tenant-a 的仓储无法修改 tenant-b 的成员。
      expect(await tenantA.updateRole('user-1', 'admin', 12)).toBe(true);
      expect((await tenantA.find('user-1'))?.role).toBe('admin');
      expect((await tenantB.find('user-1'))?.role).toBe('viewer');

      expect(await tenantA.countActiveOwners()).toBe(0);
      await tenantA.updateRole('user-1', 'owner', 13);
      expect(await tenantA.countActiveOwners()).toBe(1);

      expect(await tenantA.remove('user-1')).toBe(true);
      expect(await tenantA.find('user-1')).toBeUndefined();
      expect(await tenantB.find('user-1')).toBeDefined();

      expect(await tenantA.remove('user-1')).toBe(false);
      expect(await tenantA.updateRole('user-1', 'owner', 14)).toBe(false);
    } finally {
      await database.cleanup();
    }
  });

  it('lists active tenant access for a user', async () => {
    const database = await createTestDatabase();

    try {
      await seedUser(database.db, 'user-1', 'alice');
      await seedUser(database.db, 'user-2', 'bob');
      await seedTenant(database.db, 'tenant-a', 'tenant-a');
      await seedTenant(database.db, 'tenant-b', 'tenant-b');

      await new MembershipRepository(database.db, 'tenant-a').add({
        userId: 'user-1',
        role: 'owner',
        now: 10,
      });
      await new MembershipRepository(database.db, 'tenant-b').add({
        userId: 'user-1',
        role: 'viewer',
        now: 11,
      });
      await new MembershipRepository(database.db, 'tenant-b').add({
        userId: 'user-2',
        role: 'developer',
        now: 12,
      });

      const access = new MembershipAccessRepository(database.db);

      expect((await access.listActiveForUser('user-1')).map((item) => item.tenant.slug)).toEqual([
        'tenant-a',
        'tenant-b',
      ]);
      expect((await access.findActiveForUser('user-1', 'tenant-b'))?.role).toBe('viewer');
      expect(await access.findActiveForUser('user-1', 'tenant-c')).toBeUndefined();
      expect(await access.listActiveForUser('user-2')).toHaveLength(1);
    } finally {
      await database.cleanup();
    }
  });
});

describe('SessionRepository', () => {
  it('stores hashes, revokes sessions and scopes revocation', async () => {
    const database = await createTestDatabase();

    try {
      await seedUser(database.db, 'user-1');
      await seedUser(database.db, 'user-2');
      await seedTenant(database.db, 'tenant-a');
      await seedTenant(database.db, 'tenant-b');

      const repository = new SessionRepository(database.db);
      const session = await repository.create({
        id: 'session-1',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-1',
        expiresAt: 1_000,
        now: 10,
      });

      expect(await repository.findByTokenHash('hash-1')).toEqual(session);
      expect(await repository.findById('session-1')).toEqual(session);

      expect(await repository.touchLastSeen('session-1', 20)).toBe(true);
      expect((await repository.findById('session-1'))?.lastSeenAt).toBe(20);

      expect(await repository.setActiveTenant('session-1', 'tenant-b', 21)).toBe(true);
      expect((await repository.findById('session-1'))?.tenantId).toBe('tenant-b');

      const other = await repository.create({
        id: 'session-2',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-2',
        expiresAt: 2_000,
        now: 11,
      });

      expect(await repository.revoke('session-2', 22)).toBe(true);
      expect(await repository.revoke('session-2', 23)).toBe(false);
      expect((await repository.findById(other.id))?.revokedAt).toBe(22);
      expect(await repository.touchLastSeen('session-2', 24)).toBe(false);

      expect(await repository.revoke('session-1', 25)).toBe(true);
      expect(await repository.revokeByTokenHash('hash-1', 26)).toBe(false);
      expect(await repository.revokeByTokenHash('hash-2', 26)).toBe(false);
    } finally {
      await database.cleanup();
    }
  });

  it('revokes all sessions except the current one and by tenant', async () => {
    const database = await createTestDatabase();

    try {
      await seedUser(database.db, 'user-1');
      await seedTenant(database.db, 'tenant-a');
      await seedTenant(database.db, 'tenant-b');

      const repository = new SessionRepository(database.db);
      await repository.create({
        id: 'session-1',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-1',
        expiresAt: 1_000,
        now: 1,
      });
      await repository.create({
        id: 'session-2',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-2',
        expiresAt: 1_000,
        now: 1,
      });
      await repository.create({
        id: 'session-3',
        userId: 'user-1',
        tenantId: 'tenant-b',
        tokenHash: 'hash-3',
        expiresAt: 1_000,
        now: 1,
      });

      expect(await repository.revokeAllForUser('user-1', 10, 'session-1')).toBe(2);
      expect((await repository.findById('session-1'))?.revokedAt).toBeNull();
      expect((await repository.findById('session-2'))?.revokedAt).toBe(10);
      expect((await repository.findById('session-3'))?.revokedAt).toBe(10);

      await repository.create({
        id: 'session-4',
        userId: 'user-1',
        tenantId: 'tenant-b',
        tokenHash: 'hash-4',
        expiresAt: 500,
        now: 1,
      });

      expect(await repository.revokeForUserInTenant('user-1', 'tenant-b', 20)).toBe(1);
      expect((await repository.findById('session-4'))?.revokedAt).toBe(20);

      expect(await repository.deleteExpired(600)).toBe(1);
      expect(await repository.findByTokenHash('hash-4')).toBeUndefined();
      expect(await repository.findByTokenHash('hash-1')).toBeDefined();
    } finally {
      await database.cleanup();
    }
  });
});

describe('audit log repositories', () => {
  it('writes tenantless events but only lists tenant-scoped entries', async () => {
    const database = await createTestDatabase();

    try {
      await seedUser(database.db, 'user-1', 'alice');
      await seedTenant(database.db, 'tenant-a');
      await seedTenant(database.db, 'tenant-b');

      const writer = new AuditLogWriter(database.db);
      await writer.append({
        action: 'auth.login.failure',
        actorUserId: 'user-1',
        detail: { reason: 'invalid_credentials' },
        now: 10,
      });
      await writer.append({
        tenantId: 'tenant-a',
        actorUserId: 'user-1',
        action: 'auth.login.success',
        resourceType: 'session',
        resourceId: 'session-1',
        now: 20,
      });
      await writer.append({
        tenantId: 'tenant-b',
        actorUserId: 'user-1',
        action: 'tenant.member.add',
        resourceType: 'tenant_member',
        now: 30,
      });

      const tenantA = new TenantAuditLogRepository(database.db, 'tenant-a');
      const page = await tenantA.list();

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.action).toBe('auth.login.success');
      expect(page.items[0]?.actorUsername).toBe('alice');
      expect(page.nextCursor).toBeNull();

      const tenantB = new TenantAuditLogRepository(database.db, 'tenant-b');
      expect((await tenantB.list({ action: 'tenant.member.add' })).items).toHaveLength(1);
      expect((await tenantB.list({ action: 'auth.login.success' })).items).toHaveLength(0);
      expect((await tenantB.list({ resourceType: 'tenant_member' })).items).toHaveLength(1);
    } finally {
      await database.cleanup();
    }
  });

  it('paginates audit entries with a stable cursor', async () => {
    const database = await createTestDatabase();

    try {
      await seedTenant(database.db, 'tenant-a');
      const writer = new AuditLogWriter(database.db);

      for (let index = 0; index < 5; index += 1) {
        await writer.append({
          tenantId: 'tenant-a',
          action: 'tenant.update',
          detail: { index },
          now: 100 + index,
        });
      }

      const repository = new TenantAuditLogRepository(database.db, 'tenant-a');
      const first = await repository.list({ limit: 2 });

      expect(first.items).toHaveLength(2);
      expect(first.items.map((item) => item.createdAt)).toEqual([104, 103]);
      expect(first.nextCursor).not.toBeNull();

      const second = await repository.list({
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      });

      expect(second.items.map((item) => item.createdAt)).toEqual([102, 101]);
      expect(second.nextCursor).not.toBeNull();

      const third = await repository.list({
        limit: 2,
        ...(second.nextCursor === null ? {} : { cursor: second.nextCursor }),
      });

      expect(third.items.map((item) => item.createdAt)).toEqual([100]);
      expect(third.nextCursor).toBeNull();

      await expect(repository.list({ cursor: 'not-a-cursor' })).rejects.toThrow(ValidationError);
      expect((await repository.list({ limit: 0 })).items).toHaveLength(1);
    } finally {
      await database.cleanup();
    }
  });
});
