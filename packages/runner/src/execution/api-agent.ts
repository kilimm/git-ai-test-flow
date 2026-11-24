// 本文件所有改动要求遵循 agent-rules 规范
import { StepExecutionError } from './types.js';
import type { StepRuntime } from './types.js';

/**
 * 最小化 LLM 客户端契约（结构化类型）。
 * 不在 runner 里 import @gait/agent（会形成 agent->runner 反向依赖 + 破坏层边界），
 * 由调用方（worker）注入实际 LlmClient。
 */
export interface ApiAgentLlm {
  generate(request: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  }): Promise<{ text: string }>;
}

/**
 * API-agent：把自然语言指令转成一次具体的 HTTP 请求并执行。
 *
 * 用于 api/db 层用例里以 `[agent] ...` 形式描述的、语义明确但不想手写
 * method/path/body 的接口操作（例如「发送解密后内容为"测试留言"的发布请求」）。
 * 由 LLM 依据接口上下文产出结构化请求，再通过 runtime.http 发出，并把结果写入
 * runtime.lastResponse，使后续 `the response ...` 断言可直接复用。
 */

export interface ApiAgentModelOutput {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface ApiAgentDeps {
  llm: ApiAgentLlm;
  /** 场景名/特征路径等，帮助 LLM 理解上下文。 */
  scenarioHint: string;
}

const SYSTEM_PROMPT = `你是 API 测试助手。根据测试步骤的自然语言描述，产出一个要发送的 HTTP 请求。
只输出 JSON，不要解释。JSON 结构：
{"method":"GET|POST|PUT|PATCH|DELETE","path":"以 / 开头的路径","headers":{可选},"body":字符串或null}
约束：
- path 是相对 API base URL 的路径（如 "/api/messages"）。
- 若步骤涉及 JSON 请求体，body 必须是合法 JSON 字符串。
- 不要包含 host；不要编造鉴权头（除非步骤明确要求）。`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // 去掉可能的 ```json ``` 代码块包裹。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);

  if (fenced !== null) {
    return JSON.parse(fenced[1]!.trim());
  }

  // 截取第一个 { 到最后一个 }。
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  return JSON.parse(trimmed);
}

function validateOutput(raw: unknown): ApiAgentModelOutput {
  if (typeof raw !== 'object' || raw === null) {
    throw new StepExecutionError('API_AGENT_INVALID', 'API agent did not return an object', 'error');
  }

  const obj = raw as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method.toUpperCase() : '';
  const path = typeof obj.path === 'string' ? obj.path : '';

  if (!/^[A-Z]+$/.test(method) || path.length === 0) {
    throw new StepExecutionError(
      'API_AGENT_INVALID',
      `API agent returned invalid request: ${JSON.stringify(raw).slice(0, 200)}`,
      'error',
    );
  }

  const headers =
    typeof obj.headers === 'object' && obj.headers !== null
      ? Object.fromEntries(
          Object.entries(obj.headers as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : undefined;

  const body =
    obj.body === null || obj.body === undefined
      ? null
      : typeof obj.body === 'string'
        ? obj.body
        : JSON.stringify(obj.body);

  return {
    method,
    path: path.startsWith('/') ? path : `/${path}`,
    ...(headers === undefined ? {} : { headers }),
    body,
  };
}

export async function runApiAgentStep(
  instruction: string,
  runtime: StepRuntime,
  apiAgent: ApiAgentDeps,
): Promise<{ output: Record<string, unknown> }> {
  let text: string;

  try {
    const result = await apiAgent.llm.generate({
      system: SYSTEM_PROMPT,
      user: `场景：${apiAgent.scenarioHint}\n步骤：${instruction}`,
      temperature: 0,
      maxTokens: 1024,
    });
    text = result.text;
  } catch (error) {
    throw new StepExecutionError(
      'API_AGENT_LLM_FAILED',
      `API agent LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }

  let parsed: unknown;

  try {
    parsed = extractJson(text);
  } catch {
    throw new StepExecutionError(
      'API_AGENT_INVALID',
      `API agent returned non-JSON: ${text.slice(0, 200)}`,
      'error',
    );
  }

  const request = validateOutput(parsed);

  const response = await runtime.http.request({
    method: request.method,
    path: request.path,
    ...(request.headers === undefined ? {} : { headers: { ...runtime.headers, ...request.headers } }),
    body: request.body ?? null,
    retries:
      request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS' ? 1 : 0,
  });

  runtime.lastResponse = response;

  return {
    output: {
      instruction,
      request: { method: request.method, path: request.path },
      status: response.status,
    },
  };
}
