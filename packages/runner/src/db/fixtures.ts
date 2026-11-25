// 本文件所有改动要求遵循 agent-rules 规范
import { parse as parseYaml } from 'yaml';
import { resolveFromRecord } from '../steps/variables.js';
import {
  assertFixtureSql,
  assertIdentifier,
  assertNoSqlInterpolation,
  placeholderFor,
  quoteIdentifier,
  SqlGuardError,
} from './sql-guard.js';
import type { DbAdapter } from './types.js';

export interface FixtureSqlStatement {
  kind: 'sql';
  sql: string;
  params: unknown[];
}

export interface FixtureTableStatement {
  kind: 'table';
  table: string;
  rows: Record<string, unknown>[];
}

export type FixtureStatement = FixtureSqlStatement | FixtureTableStatement;

export interface FixtureDocument {
  setup: FixtureStatement[];
  teardown: FixtureStatement[];
  variables: Record<string, unknown>;
}

export interface FixtureContext {
  namespace: string;
  variables: Readonly<Record<string, unknown>>;
  resolve(text: string): string;
}

export function createFixtureContext(
  variables: Readonly<Record<string, unknown>>,
  namespace: string,
): FixtureContext {
  const values: Record<string, unknown> = {
    ...variables,
    run: {
      ...(typeof variables.run === 'object' && variables.run !== null ? variables.run : {}),
      namespace,
      shortId: namespace.replace(/^run_/, '').replace(/_$/, ''),
    },
  };

  return {
    namespace,
    variables: values,
    resolve(text) {
      return resolveFromRecord(text, values);
    },
  };
}

/**
 * 把嵌套对象展平成「点路径 → 标量」列表，供生成阶段提示词列出可用夹具变量
 * （模型只能引用真实存在的键，避免编造 {{fixture.image.base64_800x600}}）。
 */
export function flattenFixtureVariables(
  variables: Readonly<Record<string, unknown>>,
  options: { maxEntries?: number; maxValueChars?: number } = {},
): { name: string; value: string }[] {
  const maxEntries = options.maxEntries ?? 200;
  const maxValueChars = options.maxValueChars ?? 60;
  const result: { name: string; value: string }[] = [];

  const walk = (value: unknown, path: string): void => {
    if (result.length >= maxEntries) {
      return;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walk(entry, path.length === 0 ? key : `${path}.${key}`);
      }

      return;
    }

    const text =
      typeof value === 'string'
        ? value.length > maxValueChars
          ? `${value.slice(0, maxValueChars)}…(${value.length} chars)`
          : value
        : String(value);

    result.push({ name: `fixture.${path}`, value: text });
  };

  walk(variables, '');

  return result;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SqlGuardError('FIXTURE_INVALID', `${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function parseStatement(value: unknown, label: string): FixtureStatement {
  const entry = asObject(value, label);
  const sql = entry.sql;
  const table = entry.table;

  if (typeof sql === 'string') {
    const params = entry.params ?? [];

    if (!Array.isArray(params)) {
      throw new SqlGuardError('FIXTURE_INVALID', `${label}.params must be an array`);
    }

    assertNoSqlInterpolation(sql);
    assertFixtureSql(sql);

    return { kind: 'sql', sql, params };
  }

  if (typeof table === 'string') {
    validateTableName(table);
    const rows = entry.rows;

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new SqlGuardError('FIXTURE_INVALID', `${label}.rows must be a non-empty array`);
    }

    return {
      kind: 'table',
      table,
      rows: rows.map((row, index) => asObject(row, `${label}.rows[${index}]`)),
    };
  }

  throw new SqlGuardError('FIXTURE_INVALID', `${label} must contain sql or table`);
}

export function validateTableName(table: string): void {
  assertIdentifier(table, 'table name');
}

function parseStatements(value: unknown, label: string): FixtureStatement[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new SqlGuardError('FIXTURE_INVALID', `${label} must be an array`);
  }

  return value.map((entry, index) => parseStatement(entry, `${label}[${index}]`));
}

/**
 * fixtures 支持 YAML/JSON；结构：
 * setup: [{ sql, params } | { table, rows }]
 * teardown: 同上
 * 根节点为数组时视为 setup。
 */
export function parseFixtureDocument(source: string, label = 'fixtures'): FixtureDocument {
  let parsed: unknown;

  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new SqlGuardError(
      'FIXTURE_INVALID',
      `${label} is not valid YAML/JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (Array.isArray(parsed)) {
    return { setup: parseStatements(parsed, `${label}.setup`), teardown: [], variables: {} };
  }

  const document = asObject(parsed, label);
  const variables =
    document.variables === undefined || document.variables === null
      ? {}
      : asObject(document.variables, `${label}.variables`);

  return {
    setup: parseStatements(document.setup, `${label}.setup`),
    teardown: parseStatements(document.teardown, `${label}.teardown`),
    variables,
  };
}

/** 递归解析 fixture 变量中的 `{{...}}`，供步骤通过 fixture.* 引用。 */
export function resolveFixtureVariables(
  variables: Readonly<Record<string, unknown>>,
  context: FixtureContext,
): Record<string, unknown> {
  const resolveValue = (value: unknown, depth: number): unknown => {
    if (depth > 8) {
      return value;
    }

    if (typeof value === 'string') {
      return context.resolve(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => resolveValue(item, depth + 1));
    }

    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, depth + 1)]),
      );
    }

    return value;
  };

  return resolveValue(variables, 0) as Record<string, unknown>;
}

function interpolateScalar(value: unknown, context: FixtureContext): unknown {
  if (typeof value === 'string') {
    return context.resolve(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value;
  }

  throw new SqlGuardError('FIXTURE_INVALID', 'Fixture values must be primitive');
}

function interpolateParams(params: readonly unknown[], context: FixtureContext): unknown[] {
  return params.map((param) => interpolateScalar(param, context));
}

async function executeStatements(
  adapter: DbAdapter,
  statements: readonly FixtureStatement[],
  context: FixtureContext,
): Promise<number> {
  let executed = 0;

  for (const statement of statements) {
    if (statement.kind === 'sql') {
      await adapter.execute(statement.sql, interpolateParams(statement.params, context));
      executed += 1;
      continue;
    }

    const columns = [...new Set(statement.rows.flatMap((row) => Object.keys(row)))];

    for (const column of columns) {
      assertIdentifier(column, 'column name');
    }

    const placeholders = columns
      .map((_column, index) => placeholderFor(adapter.dialect, index + 1))
      .join(', ');
    const sql = `INSERT INTO ${quoteIdentifier(
      statement.table,
      adapter.dialect,
    )} (${columns.join(', ')}) VALUES (${placeholders})`;

    for (const row of statement.rows) {
      const params = columns.map((column) => interpolateScalar(row[column] ?? null, context));

      await adapter.execute(sql, params);
      executed += 1;
    }
  }

  return executed;
}

/** 执行 setup；调用方负责在 finally 中执行 teardown。 */
export async function runFixtureSetup(
  adapter: DbAdapter,
  document: FixtureDocument,
  context: FixtureContext,
): Promise<{ statements: number; teardown: () => Promise<number> }> {
  const statements = await executeStatements(adapter, document.setup, context);

  return {
    statements,
    teardown: () => executeStatements(adapter, document.teardown, context),
  };
}
