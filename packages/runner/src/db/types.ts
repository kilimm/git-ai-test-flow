// 本文件所有改动要求遵循 agent-rules 规范
import type { DatabaseType, DatabaseWriteMode } from '@gait/shared';

export interface DbAdapterConfig {
  type: DatabaseType;
  host?: string | null;
  port?: number | null;
  name: string;
  schema?: string | null;
  user?: string | null;
  password?: string | null;
  ssl: boolean;
  isTest: boolean;
  writeMode: DatabaseWriteMode;
}

export interface DbQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DbPingResult {
  ok: boolean;
  durationMs: number;
  message?: string;
}

export interface DbAdapter {
  readonly kind: DatabaseType;
  readonly dialect: DatabaseType;
  connect(): Promise<void>;
  ping(): Promise<DbPingResult>;
  /** 只读查询，内部强制 SELECT/只读语句。 */
  query(sql: string, params?: readonly unknown[]): Promise<DbQueryResult>;
  /** 仅 fixtures/teardown 使用；只允许参数化 DML，禁止 DDL。 */
  execute(sql: string, params?: readonly unknown[]): Promise<{ rowCount: number }>;
  close(): Promise<void>;
}

/** 最小化的驱动结构，便于测试注入而不依赖真实数据库。 */
export interface MysqlConnectionLike {
  query(sql: string, params?: readonly unknown[]): Promise<[unknown, unknown]>;
  ping?(): Promise<void>;
  end(): Promise<void>;
}

export interface PgClientLike {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}

export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

export interface DbAdapterDeps {
  mysqlCreateConnection?: (options: Record<string, unknown>) => Promise<MysqlConnectionLike>;
  pgClientFactory?: (options: Record<string, unknown>) => PgClientLike;
  sqliteOpen?: (path: string, options: { fileMustExist: boolean }) => SqliteDatabaseLike;
}
