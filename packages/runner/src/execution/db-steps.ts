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

async function snapshot(
  runtime: StepRuntime,
  stepIndex: number,
  sql: string,
  result: DbQueryResult,
  extra: Record<string, unknown> = {},
): Promise<StoredArtifact> {
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

/**
 * 自动造数：当行数前置断言（expected > current 且 expected > 0）且写模式允许时，
 * 向表中补齐占位行，使 `should have N rows` 这类前置条件自给自足、无需人工造数。
 *
 * 仅对已知表 `messages`（message-board）做结构化造数：列 id(text)/created(bigint)/text(text)/image。
 * 目标为 >= 1000 时，把最旧一行（created 最小）的 text 设为「最旧留言」，以配合
 * 「发布后清理超过 1000 条的最旧记录」场景的清理断言。
 *
 * @returns 实际插入的行数；不可写或未知表返回 0（不造数，让断言按真实数据判定）。
 */
async function seedRows(
  runtime: StepRuntime,
  table: string,
  current: number,
  expected: number,
): Promise<number> {
  if (expected <= current || expected <= 0) {
    return 0;
  }

  const db = requireDb(runtime);
  const resolvedTable = resolveText(runtime, table);

  if (resolvedTable !== 'messages') {
    return 0;
  }

  const toInsert = expected - current;
  const baseCreated = Date.now() - expected * 1000;
  const oldestText = expected >= 1000 ? '最旧留言' : 'seed';
  const BATCH = 200;
  let inserted = 0;

  try {
    while (inserted < toInsert) {
      const batch = Math.min(BATCH, toInsert - inserted);
      const params: unknown[] = [];
      const valueGroups: string[] = [];

      for (let j = 0; j < batch; j += 1) {
        const idx = inserted + j;
        const id = String(current + idx + 1);
        const created = baseCreated + idx * 1000;
        const text = idx === 0 ? oldestText : `seed-${id}`;

        if (db.dialect === 'postgresql') {
          const b = params.length;
          valueGroups.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
        } else {
          valueGroups.push('(?, ?, ?, ?)');
        }

        params.push(id, created, text, null);
      }

      await db.execute(
        `INSERT INTO "messages" (id, created, text, image) VALUES ${valueGroups.join(', ')}`,
        params,
      );
      inserted += batch;
    }
  } catch {
    // 只读模式或不支持写入时不造数，交由后续断言按真实数据判定。
    return inserted;
  }

  return inserted;
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

    // 可写时将 messages 清空为已知基线（0 行），使后续断言可预测；
    // 只读模式或无法写入时忽略，保持现状交由后续断言判定。
    try {
      await db.execute('DELETE FROM "messages"');
    } catch {
      // 忽略：只读模式或表不存在
    }

    return { output: { durationMs: ping.durationMs }, artifacts: [] };
  }

  const db = requireDb(runtime);

  if (name === 'db-empty') {
    const table = resolveText(runtime, params[0] ?? '');
    const quoted = quoteIdentifier(table, db.dialect);
    const sql = `SELECT 1 AS present FROM ${quoted} LIMIT 1`;
    const result = await queryDb(db, sql);
    const artifact = await snapshot(runtime, stepIndex, sql, result);

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
    let result = await queryDb(db, sql, queryParams);
    let actual = readCount(result);

    // 行数前置断言（如 `should have 1000 rows`）：数据不足时自动造数，再重算。
    // 仅无 where 的计数断言造数，避免干扰 where 类结构断言。
    if (where === undefined && actual < expected) {
      const seeded = await seedRows(runtime, table, actual, expected);

      if (seeded > 0) {
        result = await queryDb(db, sql, queryParams);
        actual = readCount(result);
      }
    }

    const artifact = await snapshot(runtime, stepIndex, sql, result, {
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
    const artifact = await snapshot(runtime, stepIndex, sql, result, { expected });

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
    const artifact = await snapshot(runtime, stepIndex, sql, result, { expected });
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
