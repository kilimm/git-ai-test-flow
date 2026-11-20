// 本文件所有改动要求遵循 agent-rules 规范
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { tenants } from '../src/schema.js';
import { createTestDatabase } from '../src/testing.js';

function countAppliedMigrations(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as
    { count: number } | undefined;

  return row?.count ?? 0;
}

describe('database migrations', () => {
  it('creates the tenant table and can run repeatedly', () => {
    const database = createTestDatabase();

    try {
      const table = database.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'")
        .get();

      expect(table).toEqual({ name: 'tenants' });

      const applied = countAppliedMigrations(database.sqlite);
      expect(applied).toBeGreaterThan(0);

      runMigrations(database);
      expect(countAppliedMigrations(database.sqlite)).toBe(applied);
    } finally {
      database.cleanup();
    }
  });

  it('enforces tenant slug uniqueness through Drizzle', () => {
    const database = createTestDatabase();

    try {
      database.db
        .insert(tenants)
        .values({
          id: 'tenant-1',
          slug: 'acme',
          name: 'Acme',
          createdAt: 1,
          updatedAt: 1,
        })
        .run();

      expect(() =>
        database.db
          .insert(tenants)
          .values({
            id: 'tenant-2',
            slug: 'acme',
            name: 'Acme Duplicate',
            createdAt: 2,
            updatedAt: 2,
          })
          .run(),
      ).toThrow(/UNIQUE constraint failed/);

      const rows = database.db.select().from(tenants).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.slug).toBe('acme');
    } finally {
      database.cleanup();
    }
  });
});
