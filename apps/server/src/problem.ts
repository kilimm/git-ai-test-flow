// 本文件所有改动要求遵循 agent-rules 规范
import { toProblemDetails } from '@gait/config';
import type { ProblemDetails } from '@gait/config';

const PROBLEM_TYPE = 'about:blank';

const REQUEST_ERROR_TITLES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
});

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined;
}

function readNonEmptyString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getValidationIssues(error: unknown): UnknownRecord[] | undefined {
  const record = asRecord(error);
  const validation = record?.['validation'];

  if (!Array.isArray(validation)) {
    return undefined;
  }

  return validation.filter((issue): issue is UnknownRecord => asRecord(issue) !== undefined);
}

function getStatusCode(error: unknown): number | undefined {
  const record = asRecord(error);
  const statusCode = record?.['statusCode'];

  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : undefined;
}

/**
 * RFC 7807 的 instance 与访问日志只保留路径，避免查询参数中的敏感值外泄。
 */
export function getRequestPath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * 将 Fastify 自身的错误（参数校验、4xx 协议错误）映射为 RFC 7807，
 * 其余错误交给 @gait/config 的统一转换（AppError / ZodError / 未知错误）。
 */
export function toHttpProblem(error: unknown, instance: string): ProblemDetails {
  const validationIssues = getValidationIssues(error);

  if (validationIssues !== undefined) {
    return {
      type: PROBLEM_TYPE,
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_ERROR',
      detail: 'Request validation failed',
      instance,
      errors: validationIssues.map((issue) => ({
        path: readNonEmptyString(issue, 'instancePath') ?? '',
        message: readNonEmptyString(issue, 'message') ?? 'Invalid value',
        code: readNonEmptyString(issue, 'keyword') ?? 'invalid',
      })),
    };
  }

  const statusCode = getStatusCode(error);

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    const record = asRecord(error);

    return {
      type: PROBLEM_TYPE,
      title: REQUEST_ERROR_TITLES[statusCode] ?? 'Request Error',
      status: statusCode,
      code: (record !== undefined ? readNonEmptyString(record, 'code') : undefined) ?? 'HTTP_ERROR',
      detail:
        (record !== undefined ? readNonEmptyString(record, 'message') : undefined) ??
        'Request failed',
      instance,
    };
  }

  return toProblemDetails(error, instance);
}
