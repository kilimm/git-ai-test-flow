// 本文件所有改动要求遵循 agent-rules 规范
import type { z } from 'zod';
import type { GenerationTokenUsage, LlmProvider } from '@gait/shared';

export interface LlmRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmClient {
  generate(request: LlmRequest): Promise<{ text: string; usage: GenerationTokenUsage }>;
}

export interface LlmClientConfig {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class LlmProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmProviderError';
    this.code = code;
  }
}

export class StructuredOutputError extends Error {
  readonly code = 'STRUCTURED_OUTPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4_096;

function joinUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: LlmProvider,
  fetchImpl: FetchImpl,
): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

    throw new LlmProviderError(
      timedOut ? 'LLM_TIMEOUT' : 'LLM_NETWORK_ERROR',
      timedOut ? `${provider} request timed out` : `${provider} request failed`,
      { cause: error },
    );
  }

  const bodyText = (await response.text()).slice(0, 200_000);

  if (!response.ok) {
    // 供应商错误响应可能包含请求内容，不进入错误信息/审计。
    throw new LlmProviderError('LLM_HTTP_ERROR', `${provider} returned HTTP ${response.status}`);
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);

    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('not an object');
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new LlmProviderError('LLM_INVALID_RESPONSE', `${provider} returned invalid JSON`);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

type FetchImpl = typeof fetch;

async function callOpenAiCompatible(
  config: LlmClientConfig,
  request: LlmRequest,
  fetchImpl: FetchImpl,
): Promise<{ text: string; usage: GenerationTokenUsage }> {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.temperature ?? config.temperature ?? 0.1,
    max_tokens: request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
    response_format: { type: 'json_object' },
  };
  const parsed = await requestJson(
    joinUrl(config.baseUrl, 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify(body),
    },
    request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    config.provider,
    fetchImpl,
  );
  const choices = parsed.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmProviderError('LLM_INVALID_RESPONSE', 'OpenAI-compatible response has no choices');
  }

  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const text = typeof message?.content === 'string' ? message.content : '';
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;

  return {
    text,
    usage: {
      inputTokens: numberOrZero(usage.prompt_tokens),
      outputTokens: numberOrZero(usage.completion_tokens),
      model: config.model,
    },
  };
}

async function callAnthropic(
  config: LlmClientConfig,
  request: LlmRequest,
  fetchImpl: FetchImpl,
): Promise<{ text: string; usage: GenerationTokenUsage }> {
  const body = {
    model: config.model,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
    temperature: request.temperature ?? config.temperature ?? 0.1,
    max_tokens: request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  const parsed = await requestJson(
    config.baseUrl.replace(/\/+$/, '').endsWith('/v1')
      ? joinUrl(config.baseUrl, 'messages')
      : joinUrl(config.baseUrl, 'v1/messages'),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(config.apiKey === undefined ? {} : { 'x-api-key': config.apiKey }),
      },
      body: JSON.stringify(body),
    },
    request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    config.provider,
    fetchImpl,
  );
  const content = parsed.content;

  if (!Array.isArray(content)) {
    throw new LlmProviderError('LLM_INVALID_RESPONSE', 'Anthropic response has no content');
  }

  const text = content
    .map((part) => ((part as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;

  return {
    text,
    usage: {
      inputTokens: numberOrZero(usage.input_tokens),
      outputTokens: numberOrZero(usage.output_tokens),
      model: config.model,
    },
  };
}

async function callGemini(
  config: LlmClientConfig,
  request: LlmRequest,
  fetchImpl: FetchImpl,
): Promise<{ text: string; usage: GenerationTokenUsage }> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const path = base.endsWith('/v1beta')
    ? `models/${encodeURIComponent(config.model)}:generateContent`
    : `v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    generationConfig: {
      temperature: request.temperature ?? config.temperature ?? 0.1,
      maxOutputTokens: request.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
      responseMimeType: 'application/json',
    },
  };
  const parsed = await requestJson(
    joinUrl(base, path),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey === undefined ? {} : { 'x-goog-api-key': config.apiKey }),
      },
      body: JSON.stringify(body),
    },
    request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    config.provider,
    fetchImpl,
  );
  const candidates = parsed.candidates;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new LlmProviderError('LLM_INVALID_RESPONSE', 'Gemini response has no candidates');
  }

  const parts = (candidates[0] as { content?: { parts?: unknown[] } }).content?.parts;

  if (!Array.isArray(parts)) {
    throw new LlmProviderError('LLM_INVALID_RESPONSE', 'Gemini response has no parts');
  }

  const text = parts
    .map((part) => ((part as { text?: unknown }).text as string | undefined) ?? '')
    .join('');
  const usage = (parsed.usageMetadata ?? {}) as Record<string, unknown>;

  return {
    text,
    usage: {
      inputTokens: numberOrZero(usage.promptTokenCount),
      outputTokens: numberOrZero(usage.candidatesTokenCount),
      model: config.model,
    },
  };
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async generate(request) {
      if (config.provider === 'anthropic') {
        return callAnthropic(config, request, fetchImpl);
      }

      if (config.provider === 'gemini') {
        return callGemini(config, request, fetchImpl);
      }

      return callOpenAiCompatible(config, request, fetchImpl);
    },
  };
}

/** 从模型返回中提取 JSON，容忍 ```json 围栏与前后说明文字。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fenced === null ? [trimmed] : [fenced[1] ?? '', trimmed];

  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);

    if (start === -1) {
      continue;
    }

    const opening = candidate[start];
    const closing = opening === '{' ? '}' : ']';
    const end = candidate.lastIndexOf(closing);

    if (end <= start) {
      continue;
    }

    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
  }

  throw new StructuredOutputError('Model output did not contain valid JSON');
}

export interface StructuredGenerationResult<T> {
  value: T;
  usages: GenerationTokenUsage[];
  repairs: number;
}

/** 带 Zod 校验与一次 JSON 修复重试的结构化输出。 */
export async function generateStructured<T>(
  client: LlmClient,
  schema: z.ZodType<T>,
  request: LlmRequest,
): Promise<StructuredGenerationResult<T>> {
  const usages: GenerationTokenUsage[] = [];
  let user = request.user;
  let repairs = 0;
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.generate({ ...request, user });
    usages.push(response.usage);

    try {
      const parsed = schema.safeParse(extractJson(response.text));

      if (parsed.success) {
        return { value: parsed.data, usages, repairs };
      }

      lastError = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    repairs += 1;
    user = [
      request.user,
      '',
      '上一次输出不满足 JSON Schema。请只输出符合 schema 的 JSON，不要输出解释。',
      `错误：${lastError.slice(0, 1_000)}`,
      `上一次输出：${response.text.slice(0, 2_000)}`,
    ].join('\n');
  }

  throw new StructuredOutputError(`Model output failed schema validation: ${lastError}`);
}
