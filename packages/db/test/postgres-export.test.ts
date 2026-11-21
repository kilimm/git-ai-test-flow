// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';
import { TenantRepository } from '../src/repositories/tenant-repository.js';
import { UserRepository } from '../src/repositories/user-repository.js';
import { ProjectRepository } from '../src/repositories/project-repository.js';
import { exportPostgresSql } from '../src/postgres-export.js';

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

describe('PostgreSQL export', () => {
  it('converts schema and writes data in foreign-key order', () => {
    const database = createTestDatabase();
    databases.push(database);
    const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: "Ac'me'" });
    new UserRepository(database.db).create({
      username: 'owner',
      passwordHash: 'hash',
      displayName: "Own'er",
    });
    new ProjectRepository(database.db, tenant.id).create({
      name: 'Demo',
      slug: 'demo',
      productRepoUrl: 'https://example.com/demo.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });
    const sql = exportPostgresSql({
      sourcePath: database.path,
      includeData: true,
    });

    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "public"');
    expect(sql).toContain('CREATE TABLE "tenants"');
    expect(sql).toContain('bigint');
    expect(sql).toContain('bytea');
    expect(sql).toContain('BEGIN;');
    expect(sql.indexOf('INSERT INTO "tenants"')).toBeLessThan(
      sql.indexOf('INSERT INTO "projects"'),
    );
    expect(sql).toContain(`'${tenant.id}'`);
    expect(sql).toContain("Ac''me''");
    expect(sql).toContain("Own''er");
    expect(sql).not.toContain('doc_modules_fts');
    expect(sql).toContain('COMMIT;');
  });

  it('can export schema only', () => {
    const database = createTestDatabase();
    databases.push(database);
    const sql = exportPostgresSql({ sourcePath: database.path });

    expect(sql).toContain('CREATE TABLE');
    expect(sql).not.toContain('INSERT INTO');
  });
});
