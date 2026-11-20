// 本文件所有改动要求遵循 agent-rules 规范
import { uuidv7 } from '@gait/config';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id';

/** 仅接受常见的请求 ID 字符，避免把任意内容写进日志与响应头。 */
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

/**
 * 优先复用上游传入的合法请求 ID；缺失或格式异常时生成 UUIDv7。
 */
export function resolveRequestId(headerValue: string | string[] | undefined): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (candidate !== undefined && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return uuidv7();
}
