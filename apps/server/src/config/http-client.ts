// 本文件所有改动要求遵循 agent-rules 规范

export interface HttpRequestOptions {
  method: 'GET' | 'POST';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}

export type HttpClient = (options: HttpRequestOptions) => Promise<HttpResponse>;

export class HttpTimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(url: string) {
    super(`Request timed out: ${url}`);
    this.name = 'HttpTimeoutError';
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value === undefined) {
        continue;
      }

      const remaining = maxBytes - total;

      if (remaining <= 0) {
        break;
      }

      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;

      if (total >= maxBytes) {
        break;
      }
    }
  } finally {
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * 生产 HTTP 客户端：不自动跟随重定向（避免重定向绕过 SSRF 校验），
 * 读取响应体有上限，超时使用 AbortSignal。
 */
export function createFetchHttpClient(): HttpClient {
  return async (options) => {
    let response: Response;
    const init: RequestInit = {
      method: options.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    };

    if (options.headers !== undefined) {
      init.headers = { ...options.headers };
    }

    if (options.body !== undefined) {
      init.body = options.body;
    }

    try {
      response = await fetch(options.url, init);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new HttpTimeoutError(options.url);
      }

      throw error;
    }

    const headers: Record<string, string> = {};

    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      headers,
      bodyText: await readLimitedBody(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      ),
    };
  };
}

export function joinUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return new URL(relativePath, normalizedBase).toString();
}
