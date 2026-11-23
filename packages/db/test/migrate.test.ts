// 本文件所有改动要求遵循 agent-rules 规范
import { count } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { OpenedDatabase } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { tenants } from '../src/schema.js';
import { createTestDatabase } from '../src/testing.js';

interface TableNameRow {
  table_name: string;
}

interface IndexNameRow {
  indexname: string;
}

interface MigrationCountRow {
  count: number;
}

describe('database migrations', () => {
  it('applies the PostgreSQL migrations to PGlite', async () => {
    const database = await createTestDatabase();

    try {
      const tables = await database.pglite.query<TableNameRow>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('tenants', 'jobs', 'feature_files')
          ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'feature_files',
        'jobs',
        'tenants',
      ]);

      const claimIndex = await database.pglite.query<IndexNameRow>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_jobs_claim'`,
      );
      expect(claimIndex.rows).toHaveLength(1);

      const applied = await database.pglite.query<MigrationCountRow>(
        'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
      );
      expect(applied.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      await database.cleanup();
    }
  });

  it('re-runs migrations idempotently on an already migrated database', async () => {
    const database = await createTestDatabase();

    try {
      const opened = {
        db: database.db,
        pool: undefined,
        close: async () => undefined,
      } as unknown as OpenedDatabase;

      await expect(runMigrations(opened)).resolves.toBeUndefined();
    } finally {
      await database.cleanup();
    }
  });

  it('enforces tenant slug uniqueness through Drizzle', async () => {
    const database = await createTestDatabase();

    try {
      await database.db.insert(tenants).values({
        id: 'tenant-1',
        slug: 'acme',
        name: 'Acme',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        database.db.insert(tenants).values({
          id: 'tenant-2',
          slug: 'acme',
          name: 'Acme Duplicate',
          createdAt: 2,
          updatedAt: 2,
        }),
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'tenants_slug_unique' },
      });

      const rows = await database.db.select().from(tenants);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.slug).toBe('acme');

      const [row] = await database.db.select({ value: count() }).from(tenants);
      expect(row?.value).toBe(1);
    } finally {
      await database.cleanup();
    }
  });
});
