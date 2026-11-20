// 本文件所有改动要求遵循 agent-rules 规范
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import { readJsonPath } from '@gait/shared';
import type { HttpExecutionResult } from './executor.js';

export class AssertionError extends Error {
  readonly code = 'ASSERTION_FAILED';
  readonly expected: unknown;
  readonly actual: unknown;

  constructor(message: string, expected: unknown, actual: unknown) {
    super(message);
    this.name = 'AssertionError';
    this.expected = expected;
    this.actual = actual;
  }
}

function brief(value: unknown, maxLength = 500): string {
  let text: string;

  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function assertStatus(response: HttpExecutionResult, expected: number): void {
  if (response.status !== expected) {
    throw new AssertionError(
      `Expected HTTP status ${expected} but received ${response.status}`,
      expected,
      response.status,
    );
  }
}

export function assertHeader(response: HttpExecutionResult, name: string, expected: string): void {
  const key = name.trim().toLowerCase();
  const actual = response.headers[key];

  if (actual === undefined) {
    throw new AssertionError(`Expected response header ${name}`, expected, null);
  }

  if (actual !== expected) {
    throw new AssertionError(
      `Expected response header ${name}=${expected} but received ${brief(actual)}`,
      expected,
      actual,
    );
  }
}

function parseExpected(raw: string): unknown {
  const trimmed = raw.trim();

  if (
    /^-?\d+(\.\d+)?$/.test(trimmed) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }

  return raw;
}

export function assertJsonPathEquals(body: unknown, path: string, expectedRaw: string): void {
  const actual = readJsonPath(body, path);

  if (actual === undefined) {
    throw new AssertionError(`Expected JSON path ${path} to exist`, expectedRaw, undefined);
  }

  const expected = parseExpected(expectedRaw);

  if (
    typeof expected === 'string' ||
    typeof expected === 'number' ||
    typeof expected === 'boolean'
  ) {
    if (actual === expected || String(actual) === String(expected)) {
      return;
    }
  } else if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return;
  }

  throw new AssertionError(
    `Expected JSON path ${path} to be ${brief(expected)} but received ${brief(actual)}`,
    expected,
    actual,
  );
}

const ajv = new Ajv({ allErrors: true, strict: false });

export function assertJsonSchema(body: unknown, schema: unknown, schemaName = 'schema'): void {
  if (schema === null || typeof schema !== 'object') {
    throw new AssertionError(`JSON ${schemaName} must be an object`, 'object', typeof schema);
  }

  let validate;

  try {
    validate = ajv.compile(schema as object);
  } catch (error) {
    throw new AssertionError(
      `JSON ${schemaName} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'valid schema',
      schema,
    );
  }

  if (!validate(body)) {
    const detail = (validate.errors ?? [])
      .slice(0, 5)
      .map((issue: ErrorObject) => `${issue.instancePath || '/'} ${issue.message ?? ''}`.trim())
      .join('; ');

    throw new AssertionError(`Response body does not match ${schemaName}: ${detail}`, schema, body);
  }
}

export function assertErrorCode(response: HttpExecutionResult, expected: string): void {
  const body = response.json;

  if (body === null || typeof body !== 'object') {
    throw new AssertionError('Expected a JSON error response body', expected, response.bodyText);
  }

  const record = body as Record<string, unknown>;
  const candidates = [
    record.code,
    (record.error as Record<string, unknown> | undefined)?.code,
  ].filter((value): value is string => typeof value === 'string');

  if (!candidates.includes(expected)) {
    throw new AssertionError(
      `Expected response error code ${expected} but received ${brief(candidates)}`,
      expected,
      candidates,
    );
  }
}
