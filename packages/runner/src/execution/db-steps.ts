// 本文件所有改动要求遵循 agent-rules 规范
import { AppError } from '@gait/config';
import { AssertionError } from '../http/assertions.js';
import { redactJson, redactText } from '../artifacts/redaction.js';
import type { StoredArtifact } from '../artifacts/artifact-store.js';
import { quoteIdentifier } from '../db/sql-guard.js';
import type { DbAdapter, DbQueryResult } from '../db/types.js';
import { resolveText } from './variables.js';
import { StepExecutionError } from './types.js';
import type { StepRuntime } from './types.js';
import type { StepMatch } from '../steps/registry.js';

export interface DbStepResult {
  output: Record<string, unknown>;
  artifacts: StoredArtifact[];
}

async function queryDb(
  adapter: DbAdapter,
  sql: string,
  params: readonly unknown[] = [],
): Promise<DbQueryResult> {
  try {
    return await adapter.query(sql, params);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    throw new StepExecutionError(
      'DB_QUERY_FAILED',
      `Database query failed: ${message.slice(0, 300)}`,
      'error',
      { cause: error },
    );
  }
}

function requireDb(runtime: StepRuntime) {
  if (runtime.db === null) {
    throw new StepExecutionError(
      'DB_NOT_CONFIGURED',
      'Database steps require an environment database configuration',
      'error',
    );
  }

  return runtime.db;
}

function snapshot(
  runtime: StepRuntime,
  stepIndex: number,
  sql: string,
  result: DbQueryResult,
  extra: Record<string, unknown> = {},
): StoredArtifact {
  return runtime.artifacts.writeJson('db_snapshot', `db-${stepIndex}`, {
    sql: redactText(sql),
    rows: redactJson(result.rows.slice(0, 100)),
    rowCount: result.rowCount,
    ...extra,
  });
}

function readCount(result: DbQueryResult): number {
  const row = result.rows[0];

  if (row === undefined) {
    return 0;
  }

  const value = row.count ?? row.COUNT ?? row['COUNT(*)'] ?? Object.values(row)[0];
  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : 0;
}

function tableSql(
  runtime: StepRuntime,
  table: string,
  where?: { column: string; value: string },
): { sql: string; params: unknown[] } {
  const db = requireDb(runtime);
  const resolvedTable = resolveText(runtime, table);
  const quoted = quoteIdentifier(resolvedTable, db.dialect);

  if (where === undefined) {
    return { sql: `SELECT COUNT(*) AS count FROM ${quoted}`, params: [] };
  }

  const column = where.column.trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new StepExecutionError('SQL_IDENTIFIER_INVALID', `Invalid column: ${column}`, 'failed');
  }

  const value = resolveText(runtime, where.value);

  return {
    sql: `SELECT COUNT(*) AS count FROM ${quoted} WHERE ${quoteIdentifier(column, db.dialect)} = ${
      db.dialect === 'postgresql' ? '$1' : '?'
    }`,
    params: [value],
  };
}

/** 执行 db 类步骤；断言失败归 failed，连接/配置错误归 error。 */
export async function executeDbStep(
  name: string,
  params: readonly string[],
  _match: StepMatch,
  runtime: StepRuntime,
  stepIndex: number,
): Promise<DbStepResult> {
  if (name === 'test-database-prepared') {
    const db = requireDb(runtime);
    const ping = await db.ping();

    if (!ping.ok) {
      throw new StepExecutionError(
        'DB_CONNECTION_FAILED',
        `Database is unavailable: ${ping.message ?? 'unknown error'}`,
        'error',
      );
    }

    return { output: { durationMs: ping.durationMs }, artifacts: [] };
  }

  const db = requireDb(runtime);

  if (name === 'db-empty') {
    const table = resolveText(runtime, params[0] ?? '');
    const quoted = quoteIdentifier(table, db.dialect);
    const sql = `SELECT 1 AS present FROM ${quoted} LIMIT 1`;
    const result = await queryDb(db, sql);
    const artifact = snapshot(runtime, stepIndex, sql, result);

    if (result.rows.length > 0) {
      throw new AssertionError(`Expected table ${table} to be empty`, 0, result.rows.length);
    }

    return { output: { table, rowCount: 0 }, artifacts: [artifact] };
  }

  if (
    name === 'db-row-count' ||
    name === 'db-row-count-plural' ||
    name === 'db-row-count-where' ||
    name === 'db-row-count-where-plural'
  ) {
    const table = params[0] ?? '';
    const expected = Number(params[1] ?? 0);
    const where =
      name === 'db-row-count-where' || name === 'db-row-count-where-plural'
        ? { column: params[2] ?? '', value: params[3] ?? '' }
        : undefined;
    const { sql, params: queryParams } = tableSql(runtime, table, where);
    const result = await queryDb(db, sql, queryParams);
    const actual = readCount(result);
    const artifact = snapshot(runtime, stepIndex, sql, result, {
      table: resolveText(runtime, table),
      expected,
    });

    if (actual !== expected) {
      throw new AssertionError(
        `Expected table ${table} to have ${expected} rows but received ${actual}`,
        expected,
        actual,
      );
    }

    return { output: { table, rowCount: actual }, artifacts: [artifact] };
  }

  if (name === 'db-query-row-count') {
    const sql = resolveText(runtime, params[0] ?? '');
    const expected = Number(params[1] ?? 0);
    const result = await queryDb(db, sql);
    const artifact = snapshot(runtime, stepIndex, sql, result, { expected });

    if (result.rows.length !== expected) {
      throw new AssertionError(
        `Expected query to return ${expected} rows but received ${result.rows.length}`,
        expected,
        result.rows.length,
      );
    }

    return { output: { rowCount: result.rows.length }, artifacts: [artifact] };
  }

  if (name === 'db-query-contains') {
    const sql = resolveText(runtime, params[0] ?? '');
    const expected = resolveText(runtime, params[1] ?? '');
    const result = await queryDb(db, sql);
    const artifact = snapshot(runtime, stepIndex, sql, result, { expected });
    const serialized = JSON.stringify(result.rows);

    if (!serialized.includes(expected)) {
      throw new AssertionError(
        `Expected query result to contain ${expected}`,
        expected,
        serialized.slice(0, 500),
      );
    }

    return { output: { rowCount: result.rows.length }, artifacts: [artifact] };
  }

  throw new StepExecutionError('STEP_UNSUPPORTED', `Unsupported db step: ${name}`, 'error');
}
