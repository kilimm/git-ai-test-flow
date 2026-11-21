// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, checkDatabase, openDatabase, restoreDatabase } from '../src/index.js';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';
import { TenantRepository } from '../src/repositories/tenant-repository.js';

describe('database backup and restore', () => {
  const cleanupPaths: string[] = [];
  let database: TestDatabase | undefined;

  afterEach(() => {
    database?.cleanup();
    database = undefined;

    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('creates a consistent backup and restores it atomically', async () => {
    database = createTestDatabase();
    const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);
    const backupPath = join(root, 'backup.db');
    const restoredPath = join(root, 'restored.db');

    database.close();
    const backup = await backupDatabase({ sourcePath: database.path, targetPath: backupPath });

    expect(backup.tables).toBeGreaterThan(0);
    expect(checkDatabase(backupPath).ok).toBe(true);
    expect(() => restoreDatabase({ backupPath, targetPath: restoredPath, confirm: false })).toThrow(
      /confirm=true/,
    );

    restoreDatabase({ backupPath, targetPath: restoredPath, confirm: true });

    const restored = openDatabase({ path: restoredPath });
    const restoredTenant = new TenantRepository(restored.db).findBySlug('acme');

    expect(restoredTenant?.id).toBe(tenant.id);
    restored.close();
  });

  it('rejects missing source and missing backup files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);

    await expect(
      backupDatabase({ sourcePath: join(root, 'missing.db'), targetPath: join(root, 'out.db') }),
    ).rejects.toThrow(/does not exist/);

    expect(() =>
      restoreDatabase({
        backupPath: join(root, 'missing.db'),
        targetPath: join(root, 'target.db'),
        confirm: true,
      }),
    ).toThrow(/does not exist/);
  });
});
