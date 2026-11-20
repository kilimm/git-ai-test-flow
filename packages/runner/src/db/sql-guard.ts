// 本文件所有改动要求遵循 agent-rules 规范
import { AppError } from '@gait/config';
import type { DatabaseWriteMode } from '@gait/shared';

export class SqlGuardError extends AppError {
  constructor(code: string, detail: string) {
    super(detail, { status: 400, code, detail });
    this.name = 'SqlGuardError';
  }
}

export type SqlKind = 'read' | 'write' | 'ddl' | 'unknown';

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'PRAGMA']);
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE']);
const DDL_KEYWORDS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'COPY',
  'LOAD',
  'SET',
  'LOCK',
  'UNLOCK',
]);
const READ_FORBIDDEN =
  /\b(insert|update|delete|merge|replace|truncate|create|alter|drop|into|grant|revoke|call|copy|load|set|pragma)\b/i;
const DANGEROUS_COMMENT = /(--|\/\*)/;

function stripStringsAndIdentifiers(sql: string): string {
  let result = '';
  let quote: string | null = null;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index] as string;

    if (quote === null) {
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
        result += ' ';
      } else if (character === ';') {
        result += ';';
      } else {
        result += character;
      }

      index += 1;
      continue;
    }

    if (character === '\\' && quote === "'") {
      index += 2;
      continue;
    }

    if (character === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }

      quote = null;
    }

    result += ' ';
    index += 1;
  }

  if (quote !== null) {
    throw new SqlGuardError('SQL_INVALID', 'SQL contains an unterminated string literal');
  }

  return result;
}

function stripTrailingSemicolons(value: string): string {
  return value.replace(/[;\s]+$/, '');
}

export function assertSingleStatement(sql: string): void {
  if (sql.trim().length === 0) {
    throw new SqlGuardError('SQL_INVALID', 'SQL must not be empty');
  }

  if (sql.includes('\0')) {
    throw new SqlGuardError('SQL_INVALID', 'SQL must not contain NUL bytes');
  }

  if (DANGEROUS_COMMENT.test(sql)) {
    throw new SqlGuardError('SQL_INVALID', 'SQL comments are not allowed');
  }

  const stripped = stripTrailingSemicolons(stripStringsAndIdentifiers(sql));

  if (stripped.includes(';')) {
    throw new SqlGuardError('SQL_MULTI_STATEMENT', 'Only a single SQL statement is allowed');
  }
}

export function classifySql(sql: string): SqlKind {
  assertSingleStatement(sql);
  const stripped = stripStringsAndIdentifiers(sql).trim();
  const first = /^([A-Za-z]+)/.exec(stripped)?.[1]?.toUpperCase() ?? '';

  if (DDL_KEYWORDS.has(first)) {
    return 'ddl';
  }

  if (WRITE_KEYWORDS.has(first)) {
    return 'write';
  }

  if (READ_KEYWORDS.has(first)) {
    if (first === 'WITH' && /\b(insert|update|delete|merge)\b/i.test(stripped)) {
      return 'write';
    }

    return 'read';
  }

  return 'unknown';
}

/** db step 默认只读：拒绝写语句、DDL 与 SELECT INTO。 */
export function assertReadSql(sql: string): void {
  const normalized = sql.trim().toUpperCase().startsWith('PRAGMA')
    ? sql
    : stripStringsAndIdentifiers(sql).replace(/[;\s]+$/, '');

  if (normalized.trim().toUpperCase().startsWith('PRAGMA')) {
    // PRAGMA 允许读取；写型 PRAGMA 由关键字额外拦截。
    if (/\b(pragma)\b[\s\S]*=\s*/i.test(normalized)) {
      throw new SqlGuardError('SQL_WRITE_FORBIDDEN', 'PRAGMA writes are not allowed');
    }

    return;
  }

  if (READ_FORBIDDEN.test(normalized)) {
    throw new SqlGuardError('SQL_WRITE_FORBIDDEN', 'Only read-only SQL is allowed');
  }

  if (classifySql(sql) !== 'read') {
    throw new SqlGuardError('SQL_WRITE_FORBIDDEN', 'Only read-only SQL is allowed');
  }
}

export interface FixtureSqlPolicy {
  isTest: boolean;
  writeMode: DatabaseWriteMode;
}

/** 造数写入护栏：测试库 + fixtures/full 模式，仅参数化 DML。 */
export function assertFixtureWritesAllowed(policy: FixtureSqlPolicy): void {
  if (!policy.isTest) {
    throw new SqlGuardError(
      'PRODUCTION_DATABASE_FORBIDDEN',
      'Fixtures cannot write to a production database',
    );
  }

  if (policy.writeMode === 'readonly') {
    throw new SqlGuardError(
      'SQL_WRITE_FORBIDDEN',
      'Database writeMode is readonly; fixtures require fixtures or full',
    );
  }
}

export function assertFixtureSql(sql: string): void {
  const kind = classifySql(sql);

  if (kind === 'ddl') {
    throw new SqlGuardError('SQL_DDL_FORBIDDEN', 'DDL is not allowed in fixtures');
  }

  if (kind !== 'write') {
    throw new SqlGuardError('SQL_WRITE_FORBIDDEN', 'Fixtures must use parameterized DML');
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 表名/列名只允许普通标识符，最多 schema.table 两段。 */
export function assertIdentifier(value: string, label = 'identifier'): void {
  const parts = value.split('.');

  if (parts.length > 2 || parts.some((part) => !IDENTIFIER_PATTERN.test(part))) {
    throw new SqlGuardError('SQL_IDENTIFIER_INVALID', `Invalid SQL ${label}: ${value}`);
  }
}

export function quoteIdentifier(value: string, dialect: 'mysql' | 'postgresql' | 'sqlite'): string {
  assertIdentifier(value, 'identifier');
  const quote = dialect === 'mysql' ? '`' : '"';

  return value
    .split('.')
    .map((part) => `${quote}${part}${quote}`)
    .join('.');
}

export function placeholderFor(dialect: 'mysql' | 'postgresql' | 'sqlite', index: number): string {
  return dialect === 'postgresql' ? `$${index}` : '?';
}

/** 参数只接受标量，避免驱动把对象序列化成意外 SQL 结构。 */
export function assertSafeParams(params: readonly unknown[]): void {
  for (const param of params) {
    if (
      param === null ||
      typeof param === 'string' ||
      typeof param === 'number' ||
      typeof param === 'boolean' ||
      typeof param === 'bigint' ||
      Buffer.isBuffer(param)
    ) {
      continue;
    }

    throw new SqlGuardError('SQL_PARAM_INVALID', 'SQL parameters must be primitive values');
  }
}

export function assertNoSqlInterpolation(sql: string): void {
  if (sql.includes('{{')) {
    throw new SqlGuardError(
      'SQL_INTERPOLATION_FORBIDDEN',
      'SQL text must not use variable interpolation; use parameters instead',
    );
  }
}
