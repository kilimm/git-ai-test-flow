// 本文件所有改动要求遵循 agent-rules 规范
import { AppError } from '@gait/config';
import type { DatabaseType } from '@gait/shared';
import {
  assertFixtureWritesAllowed,
  assertReadSql,
  assertSafeParams,
  assertSingleStatement,
  classifySql,
} from './sql-guard.js';
import type {
  DbAdapter,
  DbAdapterConfig,
  DbAdapterDeps,
  DbPingResult,
  DbQueryResult,
  MysqlConnectionLike,
  PgClientLike,
  SqliteDatabaseLike,
} from './types.js';

export class DbAdapterError extends AppError {
  constructor(code: string, detail: string) {
    super(detail, { status: 400, code, detail });
    this.name = 'DbAdapterError';
  }
}

function normalizeRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  );
}

function validateConfig(config: DbAdapterConfig): void {
  if (!config.isTest && config.writeMode !== 'readonly') {
    throw new DbAdapterError(
      'PRODUCTION_DATABASE_FORBIDDEN',
      'Production database connections must be readonly',
    );
  }

  if (
    config.schema !== null &&
    config.schema !== undefined &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.schema)
  ) {
    throw new DbAdapterError('DB_CONFIG_INVALID', 'Database schema must be a plain identifier');
  }

  if (config.type === 'sqlite') {
    if (config.name.trim().length === 0) {
      throw new DbAdapterError('DB_CONFIG_INVALID', 'SQLite database path is required');
    }

    return;
  }

  if (config.name.trim().length === 0) {
    throw new DbAdapterError('DB_CONFIG_INVALID', 'Database name is required');
  }
}

abstract class BaseDbAdapter implements DbAdapter {
  readonly kind: DatabaseType;
  readonly dialect: DatabaseType;
  protected readonly config: DbAdapterConfig;
  protected readonly deps: DbAdapterDeps;
  private connected = false;
  private writeAllowed: boolean;

  protected constructor(config: DbAdapterConfig, deps: DbAdapterDeps) {
    validateConfig(config);
    this.config = config;
    this.deps = deps;
    this.kind = config.type;
    this.dialect = config.type;
    this.writeAllowed = config.writeMode !== 'readonly';
  }

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  protected abstract runQuery(sql: string, params: readonly unknown[]): Promise<DbQueryResult>;
  protected abstract runExecute(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rowCount: number }>;

  protected markConnected(): void {
    this.connected = true;
  }

  protected async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  async ping(): Promise<DbPingResult> {
    const startedAt = Date.now();

    try {
      await this.ensureConnected();
      await this.runQuery(this.dialect === 'sqlite' ? 'SELECT 1 AS ok' : 'SELECT 1 AS ok', []);

      return { ok: true, durationMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<DbQueryResult> {
    assertReadSql(sql);
    assertSafeParams(params);
    await this.ensureConnected();

    return this.runQuery(sql, params);
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<{ rowCount: number }> {
    assertFixtureWritesAllowed({
      isTest: this.config.isTest,
      writeMode: this.config.writeMode,
    });
    assertSingleStatement(sql);
    assertSafeParams(params);

    if (!this.writeAllowed || classifySql(sql) !== 'write') {
      throw new DbAdapterError('SQL_WRITE_FORBIDDEN', 'Only parameterized DML is allowed');
    }

    await this.ensureConnected();

    return this.runExecute(sql, params);
  }
}

class SqliteAdapter extends BaseDbAdapter {
  private database: SqliteDatabaseLike | null = null;

  constructor(config: DbAdapterConfig, deps: DbAdapterDeps) {
    super(config, deps);
  }

  async connect(): Promise<void> {
    if (this.database !== null) {
      return;
    }

    const path = this.config.name;

    if (this.deps.sqliteOpen !== undefined) {
      this.database = this.deps.sqliteOpen(path, { fileMustExist: path !== ':memory:' });
    } else {
      const module = (await import('better-sqlite3')) as unknown as {
        default: new (path: string, options: { fileMustExist: boolean }) => SqliteDatabaseLike;
      };
      this.database = new module.default(path, { fileMustExist: path !== ':memory:' });
    }

    this.markConnected();
  }

  protected async runQuery(sql: string, params: readonly unknown[]): Promise<DbQueryResult> {
    const database = this.database;

    if (database === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const statement = database.prepare(sql);
    const rows = normalizeRows(statement.all(...params));

    return { rows, rowCount: rows.length };
  }

  protected async runExecute(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rowCount: number }> {
    const database = this.database;

    if (database === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const result = database.prepare(sql).run(...params);

    return { rowCount: result.changes };
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }
}

class MysqlAdapter extends BaseDbAdapter {
  private connection: MysqlConnectionLike | null = null;

  constructor(config: DbAdapterConfig, deps: DbAdapterDeps) {
    super(config, deps);
  }

  async connect(): Promise<void> {
    if (this.connection !== null) {
      return;
    }

    const options: Record<string, unknown> = {
      host: this.config.host ?? '127.0.0.1',
      port: this.config.port ?? 3306,
      database: this.config.name,
      user: this.config.user ?? undefined,
      password: this.config.password ?? undefined,
      ...(this.config.ssl ? { ssl: {} } : {}),
      multipleStatements: false,
      connectTimeout: 10_000,
    };

    if (this.deps.mysqlCreateConnection !== undefined) {
      this.connection = await this.deps.mysqlCreateConnection(options);
    } else {
      const module = (await import('mysql2/promise')) as unknown as {
        createConnection: (options: Record<string, unknown>) => Promise<MysqlConnectionLike>;
      };
      this.connection = await module.createConnection(options);
    }

    this.markConnected();
  }

  protected async runQuery(sql: string, params: readonly unknown[]): Promise<DbQueryResult> {
    const connection = this.connection;

    if (connection === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const [rows] = await connection.query(sql, params);
    const list = normalizeRows(rows);

    return { rows: list, rowCount: list.length };
  }

  protected async runExecute(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rowCount: number }> {
    const connection = this.connection;

    if (connection === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const [result] = await connection.query(sql, params);
    const affected = (result as { affectedRows?: unknown }).affectedRows;

    return { rowCount: typeof affected === 'number' ? affected : 0 };
  }

  async close(): Promise<void> {
    await this.connection?.end();
    this.connection = null;
  }
}

class PostgresAdapter extends BaseDbAdapter {
  private client: PgClientLike | null = null;

  constructor(config: DbAdapterConfig, deps: DbAdapterDeps) {
    super(config, deps);
  }

  async connect(): Promise<void> {
    if (this.client !== null) {
      return;
    }

    const options: Record<string, unknown> = {
      host: this.config.host ?? '127.0.0.1',
      port: this.config.port ?? 5432,
      database: this.config.name,
      user: this.config.user ?? undefined,
      password: this.config.password ?? undefined,
      ...(this.config.schema === null || this.config.schema === undefined
        ? {}
        : { options: `-c search_path=${this.config.schema}` }),
      ...(this.config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
      connectionTimeoutMillis: 10_000,
    };

    if (this.deps.pgClientFactory !== undefined) {
      this.client = this.deps.pgClientFactory(options);
    } else {
      const module = (await import('pg')) as unknown as {
        Client: new (options: Record<string, unknown>) => PgClientLike;
      };
      this.client = new module.Client(options);
    }

    await this.client.connect();
    this.markConnected();
  }

  protected async runQuery(sql: string, params: readonly unknown[]): Promise<DbQueryResult> {
    const client = this.client;

    if (client === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const result = await client.query(sql, params);

    return { rows: normalizeRows(result.rows), rowCount: result.rows.length };
  }

  protected async runExecute(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rowCount: number }> {
    const client = this.client;

    if (client === null) {
      throw new DbAdapterError('DB_NOT_CONNECTED', 'Database is not connected');
    }

    const result = await client.query(sql, params);

    return { rowCount: result.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }
}

export function createDbAdapter(config: DbAdapterConfig, deps: DbAdapterDeps = {}): DbAdapter {
  if (config.type === 'mysql') {
    return new MysqlAdapter(config, deps);
  }

  if (config.type === 'postgresql') {
    return new PostgresAdapter(config, deps);
  }

  return new SqliteAdapter(config, deps);
}
