// 本文件所有改动要求遵循 agent-rules 规范
import type { UrlSafetyChecker } from '@gait/config';
import { RUN_LIMITS } from '@gait/shared';

export interface HttpRequestInput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface HttpExecutionResult {
  requestUrl: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  json: unknown;
  durationMs: number;
  attempts: number;
  truncated: boolean;
}

export class HttpExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpExecutionError';
    this.code = code;
  }
}

export interface HttpExecutorOptions {
  baseUrl: string;
  defaultHeaders?: Readonly<Record<string, string>>;
  urlSafety?: UrlSafetyChecker;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function assertHeaders(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new HttpExecutionError('HTTP_HEADER_INVALID', `Invalid header name: ${name}`);
    }

    if (/[\r\n\0]/.test(value)) {
      throw new HttpExecutionError('HTTP_HEADER_INVALID', `Invalid header value for ${name}`);
    }
  }
}

function resolveUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  if (/^https?:\/\//i.test(path)) {
    const absolute = new URL(path);

    if (absolute.origin !== base.origin) {
      throw new HttpExecutionError(
        'HTTP_ORIGIN_FORBIDDEN',
        'Request URL must stay on the environment API origin',
      );
    }

    return absolute;
  }

  return new URL(path.replace(/^\/+/, ''), base);
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<{
  bodyText: string;
  truncated: boolean;
}> {
  if (response.body === null) {
    return { bodyText: '', truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();

    if (done || value === undefined) {
      break;
    }

    const remaining = maxBytes - total;

    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }

    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;

    if (slice.byteLength < value.byteLength) {
      truncated = true;
    }

    chunks.push(slice);
    total += slice.byteLength;
  }

  return {
    bodyText: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    truncated,
  };
}

function parseJsonBody(bodyText: string, contentType: string): unknown {
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  if (!/json/i.test(contentType) && !/^[[{]/.test(bodyText.trim())) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

/**
 * HTTP 步骤执行器：
 * - 只允许环境 API 同源；
 * - 不自动跟随重定向（由断言显式检查 3xx）；
 * - 响应体有上限，超时/取消使用 AbortSignal；
 * - 仅对网络错误/超时做有限重试。
 */
export class HttpExecutor {
  private readonly options: HttpExecutorOptions;

  constructor(options: HttpExecutorOptions) {
    this.options = options;
  }

  async request(input: HttpRequestInput): Promise<HttpExecutionResult> {
    const method = input.method.toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      throw new HttpExecutionError('HTTP_METHOD_INVALID', `Unsupported HTTP method: ${method}`);
    }

    const url = resolveUrl(this.options.baseUrl, input.path);

    if (this.options.urlSafety !== undefined) {
      this.options.urlSafety.assertHttpUrl(url.toString());
    }

    const headers: Record<string, string> = {
      ...this.options.defaultHeaders,
      ...input.headers,
    };

    assertHeaders(headers);
    const retries = Math.max(0, Math.min(input.retries ?? 0, RUN_LIMITS.MAX_HTTP_RETRIES));
    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs ?? 60_000;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const maxBytes = this.options.maxResponseBytes ?? RUN_LIMITS.MAX_RESPONSE_BYTES;
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      attempt += 1;
      const startedAt = Date.now();

      try {
        const init: RequestInit = {
          method,
          headers,
          redirect: 'manual',
          signal:
            input.signal === undefined
              ? AbortSignal.timeout(timeoutMs)
              : AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
        };

        if (input.body !== null && input.body !== undefined) {
          init.body = input.body;
        }

        const response = await fetchImpl(url.toString(), init);
        const responseHeaders: Record<string, string> = {};

        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });

        const { bodyText, truncated } = await readLimitedBody(response, maxBytes);
        const contentType = responseHeaders['content-type'] ?? '';

        return {
          requestUrl: url.toString(),
          method,
          status: response.status,
          headers: responseHeaders,
          bodyText,
          json: parseJsonBody(bodyText, contentType),
          durationMs: Date.now() - startedAt,
          attempts: attempt,
          truncated,
        };
      } catch (error) {
        lastError = error;

        if (input.signal?.aborted === true) {
          throw new HttpExecutionError('HTTP_ABORTED', 'HTTP request aborted', { cause: error });
        }

        if (attempt > retries) {
          break;
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);

    throw new HttpExecutionError('HTTP_REQUEST_FAILED', `HTTP request failed: ${message}`, {
      cause: lastError,
    });
  }
}
