// 本文件所有改动要求遵循 agent-rules 规范
import type { ZodType } from 'zod';
import { ValidationError } from '@gait/config';
import type { ProblemIssue } from '@gait/config';

function toIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string; code: string }>;
}): ProblemIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** 请求体、查询串与路径参数统一走 Zod；失败转换为 RFC 7807 校验错误。 */
export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ValidationError('Request validation failed', toIssues(result.error));
  }

  return result.data;
}
