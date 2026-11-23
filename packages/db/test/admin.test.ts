// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError, verifyPassword } from '@gait/config';
import { createPlatformAdmin, DEFAULT_ADMIN_TENANT_SLUG } from '../src/admin.js';
import { MembershipRepository, TenantRepository, UserRepository } from '../src/index.js';
import { createTestDatabase } from '../src/testing.js';

const ADMIN_PASSWORD = 'platform-admin-password-1';

describe('createPlatformAdmin', () => {
  it('creates the first platform administrator with an owner membership', async () => {
    const database = await createTestDatabase();

    try {
      const result = await createPlatformAdmin(database.db, {
        username: ' Root_Admin ',
        password: ADMIN_PASSWORD,
        email: 'ROOT@example.com',
        displayName: 'Root Admin',
      });

      expect(result.user.username).toBe('root_admin');
      expect(result.user.email).toBe('root@example.com');
      expect(result.user.displayName).toBe('Root Admin');
      expect(result.user.isPlatformAdmin).toBe(true);
      expect(result.tenant.slug).toBe(DEFAULT_ADMIN_TENANT_SLUG);
      expect(result.membership.role).toBe('owner');
      await expect(verifyPassword(result.user.passwordHash, ADMIN_PASSWORD)).resolves.toBe(true);

      const membership = await new MembershipRepository(database.db, result.tenant.id).find(
        result.user.id,
      );
      expect(membership?.role).toBe('owner');
    } finally {
      await database.cleanup();
    }
  });

  it('reuses an existing tenant slug and honours custom values', async () => {
    const database = await createTestDatabase();

    try {
      const existing = await new TenantRepository(database.db).create({
        slug: 'acme',
        name: 'Acme Existing',
      });
      const result = await createPlatformAdmin(database.db, {
        username: 'admin',
        password: ADMIN_PASSWORD,
        tenantSlug: ' ACME ',
        tenantName: 'Ignored Name',
        displayName: 'Admin',
      });

      expect(result.tenant.id).toBe(existing.id);
      expect(result.tenant.name).toBe('Acme Existing');
    } finally {
      await database.cleanup();
    }
  });

  it('rejects a second platform administrator', async () => {
    const database = await createTestDatabase();

    try {
      await createPlatformAdmin(database.db, {
        username: 'first',
        password: ADMIN_PASSWORD,
      });

      await expect(
        createPlatformAdmin(database.db, {
          username: 'second',
          password: ADMIN_PASSWORD,
          tenantSlug: 'another',
        }),
      ).rejects.toThrow(ConflictError);
    } finally {
      await database.cleanup();
    }
  });

  it('rejects duplicate usernames and emails', async () => {
    const database = await createTestDatabase();

    try {
      await new UserRepository(database.db).create({
        username: 'taken',
        email: 'taken@example.com',
        passwordHash: '$argon2id$fake',
        displayName: 'Taken',
      });

      await expect(
        createPlatformAdmin(database.db, { username: 'taken', password: ADMIN_PASSWORD }),
      ).rejects.toThrow(/Username is already in use/);

      await expect(
        createPlatformAdmin(database.db, {
          username: 'new-admin',
          password: ADMIN_PASSWORD,
          email: 'TAKEN@example.com',
        }),
      ).rejects.toThrow(/Email is already in use/);
    } finally {
      await database.cleanup();
    }
  });

  it('validates username, password and tenant slug policies', async () => {
    const database = await createTestDatabase();

    try {
      await expect(
        createPlatformAdmin(database.db, { username: 'Bad Name', password: ADMIN_PASSWORD }),
      ).rejects.toThrow(ValidationError);

      await expect(
        createPlatformAdmin(database.db, { username: 'admin', password: 'short' }),
      ).rejects.toThrow(ValidationError);

      await expect(
        createPlatformAdmin(database.db, {
          username: 'admin',
          password: ADMIN_PASSWORD,
          tenantSlug: 'Bad Slug',
        }),
      ).rejects.toThrow(ValidationError);
    } finally {
      await database.cleanup();
    }
  });
});
