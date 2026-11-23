// 本文件所有改动要求遵循 agent-rules 规范
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from 'pg';

export interface DatabaseCheckResult {
  ok: boolean;
  tables: number;
  sizeBytes: number;
  version: string;
}

export interface BackupDatabaseInput {
  /** PostgreSQL 连接串，例如 postgresql://user:pass@host:5432/db。 */
  databaseUrl: string;
  targetPath: string;
  /** pg_dump 可执行文件，默认取 PATH 中的 pg_dump。 */
  pgDumpPath?: string;
}

export interface RestoreDatabaseInput {
  backupPath: string;
  databaseUrl: string;
  /** 恢复会覆盖目标数据库；必须显式确认。 */
  confirm: boolean;
  /** pg_restore 可执行文件，默认取 PATH 中的 pg_restore。 */
  pgRestorePath?: string;
}

export interface DatabaseBackupResult {
  targetPath: string;
  sizeBytes: number;
  tables: number;
}

/** 日志与错误消息中隐藏连接串密码，避免凭据泄漏。 */
export function maskDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);

    if (url.password.length > 0) {
      url.password = '***';
    }

    return url.toString();
  } catch {
    return '<invalid database url>';
  }
}

function requireExistingFile(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }

  if (!statSync(path).isFile()) {
    throw new Error(`${label} is not a file: ${path}`);
  }
}

interface PgConnectionTarget {
  /** 去掉密码后的连接串，可安全放入命令行参数。 */
  url: string;
  /** 子进程环境变量；密码只通过 PGPASSWORD 传递，避免出现在 ps / /proc 中。 */
  env: NodeJS.ProcessEnv;
}

function connectionTarget(databaseUrl: string): PgConnectionTarget {
  let url: URL;

  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid database URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Invalid database URL: expected postgres:// or postgresql://');
  }

  const env: NodeJS.ProcessEnv = {};

  if (url.password.length > 0) {
    env.PGPASSWORD = decodeURIComponent(url.password);
    url.password = '';
  }

  return { url: url.toString(), env };
}

function runCommand(
  command: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        rejectPromise(
          new Error(
            `${command} is not installed or not on PATH; install PostgreSQL client tools (pg_dump/pg_restore)`,
          ),
        );
        return;
      }

      rejectPromise(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const detail = stderr.trim();

      rejectPromise(
        new Error(
          `${command} exited with code ${String(code)}${detail.length > 0 ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
}

async function withClient<T>(databaseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });

  await client.connect();

  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 连接探针：统计 public schema 的业务表数量并读取版本信息。 */
export async function checkDatabase(databaseUrl: string): Promise<DatabaseCheckResult> {
  return withClient(databaseUrl, async (client) => {
    const tables = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const version = await client.query<{ version: string }>('SELECT version()');
    const count = Number(tables.rows[0]?.count ?? '0');

    return {
      ok: true,
      tables: count,
      sizeBytes: Number(
        (
          await client.query<{ size: string }>(
            'SELECT pg_database_size(current_database())::text AS size',
          )
        ).rows[0]?.size ?? '0',
      ),
      version: version.rows[0]?.version ?? 'unknown',
    };
  });
}

/** 使用 pg_dump 自定义格式备份；恢复时配合 pg_restore 使用。 */
export async function backupDatabase(input: BackupDatabaseInput): Promise<DatabaseBackupResult> {
  const targetPath = resolve(input.targetPath);
  const connection = connectionTarget(input.databaseUrl);

  mkdirSync(dirname(targetPath), { recursive: true });
  await runCommand(
    input.pgDumpPath ?? 'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', `--file=${targetPath}`, connection.url],
    connection.env,
  );

  const check = await checkDatabase(input.databaseUrl);

  return {
    targetPath,
    sizeBytes: statSync(targetPath).size,
    tables: check.tables,
  };
}

/**
 * 恢复前确认备份文件存在且调用方已显式确认；使用 pg_restore --clean 覆盖目标数据库。
 * 调用方必须先停止 API/Worker，避免恢复过程中仍有写入。
 */
export async function restoreDatabase(input: RestoreDatabaseInput): Promise<DatabaseCheckResult> {
  if (!input.confirm) {
    throw new Error('Restore requires confirm=true; stop API/Worker before restoring');
  }

  const backupPath = resolve(input.backupPath);
  const connection = connectionTarget(input.databaseUrl);

  requireExistingFile(backupPath, 'Backup file');
  await runCommand(
    input.pgRestorePath ?? 'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${connection.url}`,
      backupPath,
    ],
    connection.env,
  );

  return checkDatabase(input.databaseUrl);
}
