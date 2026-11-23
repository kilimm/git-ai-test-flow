// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, maskDatabaseUrl, restoreDatabase } from '../src/backup.js';

const DATABASE_URL = 'postgresql://gait:secret@localhost:5432/gait';

describe('database backup and restore', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('requires explicit confirmation before restoring', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);

    await expect(
      restoreDatabase({
        backupPath: join(root, 'missing.dump'),
        databaseUrl: DATABASE_URL,
        confirm: false,
      }),
    ).rejects.toThrow(/confirm=true/);
  });

  it('rejects a missing backup file before invoking pg_restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);

    await expect(
      restoreDatabase({
        backupPath: join(root, 'missing.dump'),
        databaseUrl: DATABASE_URL,
        confirm: true,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('fails with an actionable error when pg_dump is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);

    await expect(
      backupDatabase({
        databaseUrl: DATABASE_URL,
        targetPath: join(root, 'app.dump'),
        pgDumpPath: 'gait-missing-pg-dump',
      }),
    ).rejects.toThrow(/not installed or not on PATH/);
  });

  it('fails with an actionable error when pg_restore is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);
    const backupPath = join(root, 'app.dump');

    writeFileSync(backupPath, 'fake backup', 'utf8');

    await expect(
      restoreDatabase({
        backupPath,
        databaseUrl: DATABASE_URL,
        confirm: true,
        pgRestorePath: 'gait-missing-pg-restore',
      }),
    ).rejects.toThrow(/not installed or not on PATH/);
  });

  it('reports non-zero pg_restore exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-backup-'));
    cleanupPaths.push(root);
    const backupPath = join(root, 'app.dump');

    writeFileSync(backupPath, 'fake backup', 'utf8');

    await expect(
      restoreDatabase({
        backupPath,
        databaseUrl: DATABASE_URL,
        confirm: true,
        pgRestorePath: process.execPath,
      }),
    ).rejects.toThrow(/exited with code/);
  });

  it('masks credentials in logs', () => {
    expect(maskDatabaseUrl(DATABASE_URL)).not.toContain('secret');
    expect(maskDatabaseUrl(DATABASE_URL)).toContain('postgresql://gait:***@localhost:5432/gait');
    expect(maskDatabaseUrl('not-a-url')).toBe('<invalid database url>');
  });
});
