// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { AppDatabase } from '../src/client.js';
import { TenantScopeError, TenantScopedRepository } from '../src/repository.js';
import { createTestDatabase } from '../src/testing.js';

class SampleRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  getTenantId(): string {
    return this.tenantId;
  }
}

describe('TenantScopedRepository', () => {
  it('keeps the tenant id for scoped queries', () => {
    const database = createTestDatabase();

    try {
      const repository = new SampleRepository(database.db, 'tenant-1');

      expect(repository.getTenantId()).toBe('tenant-1');
    } finally {
      database.cleanup();
    }
  });

  it('rejects missing or blank tenant ids', () => {
    const database = createTestDatabase();

    try {
      expect(() => new SampleRepository(database.db, '')).toThrow(TenantScopeError);
      expect(() => new SampleRepository(database.db, '   ')).toThrow(TenantScopeError);
    } finally {
      database.cleanup();
    }
  });
});
