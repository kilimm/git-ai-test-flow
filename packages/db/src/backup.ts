// 本文件所有改动要求遵循 agent-rules 规范
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export interface BackupDatabaseInput {
  sourcePath: string;
  targetPath: string;
}

export interface RestoreDatabaseInput {
  backupPath: string;
  targetPath: string;
  /** 恢复会覆盖目标数据库；必须显式确认。 */
  confirm: boolean;
}

export interface DatabaseCheckResult {
  ok: boolean;
  integrity: string;
  tables: number;
  sizeBytes: number;
}

export interface DatabaseBackupResult {
  sourcePath: string;
  targetPath: string;
  sizeBytes: number;
  tables: number;
}

function requireExistingFile(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }

  if (!statSync(path).isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

function tableCount(database: Database.Database): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { count: number } | undefined;

  return row?.count ?? 0;
}

export function checkDatabase(path: string): DatabaseCheckResult {
  requireExistingFile(path, 'Database');
  const database = new Database(path, { readonly: true, fileMustExist: true });

  try {
    const integrity = database.pragma('integrity_check', { simple: true });

    return {
      ok: integrity === 'ok',
      integrity: String(integrity),
      tables: tableCount(database),
      sizeBytes: statSync(path).size,
    };
  } finally {
    database.close();
  }
}

/** 使用 SQLite 在线备份 API，避免直接复制 WAL 模式下的写入中文件。 */
export async function backupDatabase(input: BackupDatabaseInput): Promise<DatabaseBackupResult> {
  const sourcePath = resolve(input.sourcePath);
  const targetPath = resolve(input.targetPath);

  requireExistingFile(sourcePath, 'Source database');

  if (sourcePath === targetPath) {
    throw new Error('Source and target database paths must differ');
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });

  try {
    await source.backup(targetPath);
    const check = checkDatabase(targetPath);

    if (!check.ok) {
      throw new Error(`Backup integrity check failed: ${check.integrity}`);
    }

    return {
      sourcePath,
      targetPath,
      sizeBytes: check.sizeBytes,
      tables: check.tables,
    };
  } finally {
    source.close();
  }
}

/**
 * 恢复前先验证备份完整性，再原子替换目标文件。
 * 调用方必须先停止 API/Worker，避免恢复过程中仍有写入。
 */
export function restoreDatabase(input: RestoreDatabaseInput): DatabaseCheckResult {
  if (!input.confirm) {
    throw new Error('Restore requires confirm=true; stop API/Worker before restoring');
  }

  const backupPath = resolve(input.backupPath);
  const targetPath = resolve(input.targetPath);
  const check = checkDatabase(backupPath);

  if (!check.ok) {
    throw new Error(`Backup integrity check failed: ${check.integrity}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.restore-${process.pid}.tmp`;
  const previous = `${targetPath}.pre-restore`;

  try {
    copyFileSync(backupPath, temporary);
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });

    if (existsSync(targetPath)) {
      copyFileSync(targetPath, previous);
      rmSync(targetPath, { force: true });
    }

    renameSync(temporary, targetPath);
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });
  } finally {
    rmSync(temporary, { force: true });
  }

  return check;
}
