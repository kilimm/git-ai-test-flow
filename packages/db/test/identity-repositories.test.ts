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

function seedUser(db: AppDatabase, id: string, username = id): void {
  new UserRepository(db).create({
    id,
    username,
    passwordHash: '$argon2id$fake',
    displayName: username,
    now: 1,
  });
}

function seedTenant(db: AppDatabase, id: string, slug = id): void {
  new TenantRepository(db).create({ id, slug, name: slug, now: 1 });
}

describe('UserRepository', () => {
  it('creates, finds and updates users', () => {
    const database = createTestDatabase();

    try {
      const repository = new UserRepository(database.db);
      const user = repository.create({
        id: 'user-1',
        username: 'alice',
        email: 'alice@example.com',
        passwordHash: '$argon2id$fake',
        displayName: 'Alice',
        now: 10,
      });

      expect(user.createdAt).toBe(10);
      expect(repository.findById('user-1')).toEqual(user);
      expect(repository.findByUsername('alice')).toEqual(user);
      expect(repository.findByEmail('alice@example.com')).toEqual(user);

      expect(repository.updatePasswordHash('user-1', '$argon2id$new', 20)).toBe(true);
      expect(repository.findById('user-1')?.passwordHash).toBe('$argon2id$new');

      repository.recordLogin('user-1', 30);
      expect(repository.findById('user-1')?.lastLoginAt).toBe(30);

      expect(repository.updatePasswordHash('missing', '$argon2id$new', 40)).toBe(false);
      expect(repository.findById('missing')).toBeUndefined();
    } finally {
      database.cleanup();
    }
  });

  it('counts platform administrators', () => {
    const database = createTestDatabase();

    try {
      const repository = new UserRepository(database.db);
      seedUser(database.db, 'user-1');
      repository.create({
        id: 'user-2',
        username: 'root',
        passwordHash: '$argon2id$fake',
        displayName: 'Root',
        isPlatformAdmin: true,
      });

      expect(repository.countPlatformAdmins()).toBe(1);
    } finally {
      database.cleanup();
    }
  });
});

describe('TenantRepository', () => {
  it('creates by slug and updates the name', () => {
    const database = createTestDatabase();

    try {
      const repository = new TenantRepository(database.db);
      const tenant = repository.create({ id: 'tenant-1', slug: 'acme', name: 'Acme', now: 5 });

      expect(repository.findBySlug('acme')).toEqual(tenant);
      expect(repository.findById('tenant-1')).toEqual(tenant);
      expect(repository.updateName('tenant-1', 'Acme Corp', 6)).toBe(true);
      expect(repository.findById('tenant-1')?.name).toBe('Acme Corp');
      expect(repository.updateName('missing', 'Nope', 7)).toBe(false);
    } finally {
      database.cleanup();
    }
  });
});

describe('MembershipRepository tenant isolation', () => {
  it('only sees and mutates members of the scoped tenant', () => {
    const database = createTestDatabase();

    try {
      seedUser(database.db, 'user-1', 'alice');
      seedTenant(database.db, 'tenant-a', 'tenant-a');
      seedTenant(database.db, 'tenant-b', 'tenant-b');

      const tenantA = new MembershipRepository(database.db, 'tenant-a');
      const tenantB = new MembershipRepository(database.db, 'tenant-b');

      tenantA.add({ userId: 'user-1', role: 'owner', now: 10 });
      tenantB.add({ userId: 'user-1', role: 'viewer', now: 11 });

      expect(tenantA.list()).toHaveLength(1);
      expect(tenantA.list()[0]?.role).toBe('owner');
      expect(tenantB.list()[0]?.role).toBe('viewer');
      expect(tenantA.find('user-1')?.role).toBe('owner');

      // 通过 tenant-a 的仓储无法修改 tenant-b 的成员。
      expect(tenantA.updateRole('user-1', 'admin', 12)).toBe(true);
      expect(tenantA.find('user-1')?.role).toBe('admin');
      expect(tenantB.find('user-1')?.role).toBe('viewer');

      expect(tenantA.countActiveOwners()).toBe(0);
      tenantA.updateRole('user-1', 'owner', 13);
      expect(tenantA.countActiveOwners()).toBe(1);

      expect(tenantA.remove('user-1')).toBe(true);
      expect(tenantA.find('user-1')).toBeUndefined();
      expect(tenantB.find('user-1')).toBeDefined();

      expect(tenantA.remove('user-1')).toBe(false);
      expect(tenantA.updateRole('user-1', 'owner', 14)).toBe(false);
    } finally {
      database.cleanup();
    }
  });

  it('lists active tenant access for a user', () => {
    const database = createTestDatabase();

    try {
      seedUser(database.db, 'user-1', 'alice');
      seedUser(database.db, 'user-2', 'bob');
      seedTenant(database.db, 'tenant-a', 'tenant-a');
      seedTenant(database.db, 'tenant-b', 'tenant-b');

      new MembershipRepository(database.db, 'tenant-a').add({
        userId: 'user-1',
        role: 'owner',
        now: 10,
      });
      new MembershipRepository(database.db, 'tenant-b').add({
        userId: 'user-1',
        role: 'viewer',
        now: 11,
      });
      new MembershipRepository(database.db, 'tenant-b').add({
        userId: 'user-2',
        role: 'developer',
        now: 12,
      });

      const access = new MembershipAccessRepository(database.db);

      expect(access.listActiveForUser('user-1').map((item) => item.tenant.slug)).toEqual([
        'tenant-a',
        'tenant-b',
      ]);
      expect(access.findActiveForUser('user-1', 'tenant-b')?.role).toBe('viewer');
      expect(access.findActiveForUser('user-1', 'tenant-c')).toBeUndefined();
      expect(access.listActiveForUser('user-2')).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });
});

describe('SessionRepository', () => {
  it('stores hashes, revokes sessions and scopes revocation', () => {
    const database = createTestDatabase();

    try {
      seedUser(database.db, 'user-1');
      seedUser(database.db, 'user-2');
      seedTenant(database.db, 'tenant-a');
      seedTenant(database.db, 'tenant-b');

      const repository = new SessionRepository(database.db);
      const session = repository.create({
        id: 'session-1',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-1',
        expiresAt: 1_000,
        now: 10,
      });

      expect(repository.findByTokenHash('hash-1')).toEqual(session);
      expect(repository.findById('session-1')).toEqual(session);

      expect(repository.touchLastSeen('session-1', 20)).toBe(true);
      expect(repository.findById('session-1')?.lastSeenAt).toBe(20);

      expect(repository.setActiveTenant('session-1', 'tenant-b', 21)).toBe(true);
      expect(repository.findById('session-1')?.tenantId).toBe('tenant-b');

      const other = repository.create({
        id: 'session-2',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-2',
        expiresAt: 2_000,
        now: 11,
      });

      expect(repository.revoke('session-2', 22)).toBe(true);
      expect(repository.revoke('session-2', 23)).toBe(false);
      expect(repository.findById(other.id)?.revokedAt).toBe(22);
      expect(repository.touchLastSeen('session-2', 24)).toBe(false);

      expect(repository.revoke('session-1', 25)).toBe(true);
      expect(repository.revokeByTokenHash('hash-1', 26)).toBe(false);
      expect(repository.revokeByTokenHash('hash-2', 26)).toBe(false);
    } finally {
      database.cleanup();
    }
  });

  it('revokes all sessions except the current one and by tenant', () => {
    const database = createTestDatabase();

    try {
      seedUser(database.db, 'user-1');
      seedTenant(database.db, 'tenant-a');
      seedTenant(database.db, 'tenant-b');

      const repository = new SessionRepository(database.db);
      repository.create({
        id: 'session-1',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-1',
        expiresAt: 1_000,
        now: 1,
      });
      repository.create({
        id: 'session-2',
        userId: 'user-1',
        tenantId: 'tenant-a',
        tokenHash: 'hash-2',
        expiresAt: 1_000,
        now: 1,
      });
      repository.create({
        id: 'session-3',
        userId: 'user-1',
        tenantId: 'tenant-b',
        tokenHash: 'hash-3',
        expiresAt: 1_000,
        now: 1,
      });

      expect(repository.revokeAllForUser('user-1', 10, 'session-1')).toBe(2);
      expect(repository.findById('session-1')?.revokedAt).toBeNull();
      expect(repository.findById('session-2')?.revokedAt).toBe(10);
      expect(repository.findById('session-3')?.revokedAt).toBe(10);

      repository.create({
        id: 'session-4',
        userId: 'user-1',
        tenantId: 'tenant-b',
        tokenHash: 'hash-4',
        expiresAt: 500,
        now: 1,
      });

      expect(repository.revokeForUserInTenant('user-1', 'tenant-b', 20)).toBe(1);
      expect(repository.findById('session-4')?.revokedAt).toBe(20);

      expect(repository.deleteExpired(600)).toBe(1);
      expect(repository.findByTokenHash('hash-4')).toBeUndefined();
      expect(repository.findByTokenHash('hash-1')).toBeDefined();
    } finally {
      database.cleanup();
    }
  });
});

describe('audit log repositories', () => {
  it('writes tenantless events but only lists tenant-scoped entries', () => {
    const database = createTestDatabase();

    try {
      seedUser(database.db, 'user-1', 'alice');
      seedTenant(database.db, 'tenant-a');
      seedTenant(database.db, 'tenant-b');

      const writer = new AuditLogWriter(database.db);
      writer.append({
        action: 'auth.login.failure',
        actorUserId: 'user-1',
        detail: { reason: 'invalid_credentials' },
        now: 10,
      });
      writer.append({
        tenantId: 'tenant-a',
        actorUserId: 'user-1',
        action: 'auth.login.success',
        resourceType: 'session',
        resourceId: 'session-1',
        now: 20,
      });
      writer.append({
        tenantId: 'tenant-b',
        actorUserId: 'user-1',
        action: 'tenant.member.add',
        resourceType: 'tenant_member',
        now: 30,
      });

      const tenantA = new TenantAuditLogRepository(database.db, 'tenant-a');
      const page = tenantA.list();

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.action).toBe('auth.login.success');
      expect(page.items[0]?.actorUsername).toBe('alice');
      expect(page.nextCursor).toBeNull();

      const tenantB = new TenantAuditLogRepository(database.db, 'tenant-b');
      expect(tenantB.list({ action: 'tenant.member.add' }).items).toHaveLength(1);
      expect(tenantB.list({ action: 'auth.login.success' }).items).toHaveLength(0);
      expect(tenantB.list({ resourceType: 'tenant_member' }).items).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });

  it('paginates audit entries with a stable cursor', () => {
    const database = createTestDatabase();

    try {
      seedTenant(database.db, 'tenant-a');
      const writer = new AuditLogWriter(database.db);

      for (let index = 0; index < 5; index += 1) {
        writer.append({
          tenantId: 'tenant-a',
          action: 'tenant.update',
          detail: { index },
          now: 100 + index,
        });
      }

      const repository = new TenantAuditLogRepository(database.db, 'tenant-a');
      const first = repository.list({ limit: 2 });

      expect(first.items).toHaveLength(2);
      expect(first.items.map((item) => item.createdAt)).toEqual([104, 103]);
      expect(first.nextCursor).not.toBeNull();

      const second = repository.list({
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      });

      expect(second.items.map((item) => item.createdAt)).toEqual([102, 101]);
      expect(second.nextCursor).not.toBeNull();

      const third = repository.list({
        limit: 2,
        ...(second.nextCursor === null ? {} : { cursor: second.nextCursor }),
      });

      expect(third.items.map((item) => item.createdAt)).toEqual([100]);
      expect(third.nextCursor).toBeNull();

      expect(() => repository.list({ cursor: 'not-a-cursor' })).toThrow(ValidationError);
      expect(repository.list({ limit: 0 }).items).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });
});
