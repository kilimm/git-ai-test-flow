// 本文件所有改动要求遵循 agent-rules 规范
import { readJsonPath } from '@gait/shared';
import {
  assertErrorCode,
  assertHeader,
  assertJsonPathEquals,
  assertJsonSchema,
  assertStatus,
  AssertionError,
} from '../http/assertions.js';
import { redactBody, redactHeaders } from '../artifacts/redaction.js';
import type { StoredArtifact } from '../artifacts/artifact-store.js';
import { resolveJsonSchema } from './suite-files.js';
import { setStepData, setVariable } from './variables.js';
import { StepExecutionError } from './types.js';
import type { StepRuntime } from './types.js';
import type { ParsedStep } from '../gherkin/parse.js';
import type { StepMatch } from '../steps/registry.js';
import { resolveText } from './variables.js';

export interface ApiStepResult {
  output: Record<string, unknown>;
  artifacts: StoredArtifact[];
}

function unquote(value: string): string {
  const trimmed = value.trim();

  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function requireResponse(runtime: StepRuntime) {
  if (runtime.lastResponse === null) {
    throw new StepExecutionError(
      'HTTP_RESPONSE_MISSING',
      'No HTTP response is available; send a request first',
      'failed',
    );
  }

  return runtime.lastResponse;
}

function responseSummary(runtime: StepRuntime): Record<string, unknown> {
  const response = runtime.lastResponse;

  return response === null
    ? {}
    : {
        status: response.status,
        durationMs: response.durationMs,
        attempts: response.attempts,
        requestUrl: response.requestUrl,
      };
}

/** 执行 api 类步骤；返回脱敏后的产物描述。 */
export async function executeApiStep(
  name: string,
  params: readonly string[],
  step: ParsedStep,
  match: StepMatch,
  runtime: StepRuntime,
  stepIndex: number,
): Promise<ApiStepResult> {
  if (name === 'send-request' || name === 'send-json-request') {
    const method = (params[0] ?? 'GET').toUpperCase();
    const path = resolveText(runtime, params[1] ?? '');
    const headers: Record<string, string> = {};

    for (const [headerName, headerValue] of Object.entries(runtime.headers)) {
      headers[headerName] = resolveText(runtime, headerValue);
    }

    let body: string | null = null;

    if (name === 'send-json-request') {
      body = step.docString === null ? '{}' : resolveText(runtime, step.docString);

      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }

    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept')) {
      headers.accept = 'application/json';
    }

    const artifacts: StoredArtifact[] = [];
    const requestArtifact = runtime.artifacts.writeJson('api_request', `request-${stepIndex}`, {
      method,
      url: path,
      headers: redactHeaders(headers),
      body: body === null ? null : redactBody(body),
    });

    artifacts.push(requestArtifact);

    const response = await runtime.http.request({
      method,
      path,
      headers,
      body,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      // 仅幂等方法自动重试一次网络错误/超时，避免重复创建数据。
      retries: method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 1 : 0,
    });

    runtime.lastResponse = response;
    const responseArtifact = runtime.artifacts.writeJson('api_response', `response-${stepIndex}`, {
      status: response.status,
      headers: redactHeaders(response.headers),
      body: redactBody(response.bodyText),
      durationMs: response.durationMs,
      truncated: response.truncated,
    });

    artifacts.push(responseArtifact);
    const output = {
      status: response.status,
      durationMs: response.durationMs,
      attempts: response.attempts,
      requestUrl: response.requestUrl,
      truncated: response.truncated,
    };

    setStepData(runtime, stepIndex, 'passed', {
      status: response.status,
      body: response.json,
    });

    return { output, artifacts };
  }

  if (name === 'set-header') {
    const headerName = params[0]?.trim() ?? '';
    const headerValue = resolveText(runtime, params[1] ?? '');

    if (headerName.length === 0 || /[\r\n\0]/.test(headerName + headerValue)) {
      throw new StepExecutionError('HTTP_HEADER_INVALID', 'Invalid header', 'failed');
    }

    runtime.headers[headerName] = headerValue;

    return { output: { header: headerName }, artifacts: [] };
  }

  if (name === 'store-response-field') {
    const response = requireResponse(runtime);
    const path = unquote(params[0] ?? '');
    const variableName = params[1] ?? '';
    const value = readJsonPath(response.json, path);

    if (value === undefined) {
      throw new AssertionError(`Response does not contain JSON path ${path}`, path, undefined);
    }

    setVariable(runtime, variableName, value);

    return { output: { path, variable: variableName }, artifacts: [] };
  }

  if (name === 'response-status') {
    const response = requireResponse(runtime);
    const expected = Number(params[0] ?? 0);

    assertStatus(response, expected);

    return { output: responseSummary(runtime), artifacts: [] };
  }

  if (name === 'response-header') {
    const response = requireResponse(runtime);
    const headerName = resolveText(runtime, params[0] ?? '');
    const expected = resolveText(runtime, params[1] ?? '');

    assertHeader(response, headerName, expected);

    return { output: { header: headerName }, artifacts: [] };
  }

  if (name === 'response-jsonpath') {
    const response = requireResponse(runtime);
    const path = unquote(params[0] ?? '');
    const expected = resolveText(runtime, params[1] ?? '');

    assertJsonPathEquals(response.json, path, expected);

    return { output: { path }, artifacts: [] };
  }

  if (name === 'response-json-schema') {
    const response = requireResponse(runtime);
    const reference = resolveText(runtime, params[0] ?? '');
    const schema = resolveJsonSchema(runtime.suiteRoot, reference);

    assertJsonSchema(response.json, schema, reference);

    return { output: { schema: reference }, artifacts: [] };
  }

  if (name === 'response-error-code') {
    const response = requireResponse(runtime);
    const expected = resolveText(runtime, params[0] ?? '');

    assertErrorCode(response, expected);

    return { output: { code: expected }, artifacts: [] };
  }

  if (name === 'response-time') {
    const response = requireResponse(runtime);
    const limit = Number(params[0] ?? 0);

    if (response.durationMs > limit) {
      throw new AssertionError(
        `Expected response time <= ${limit}ms but received ${response.durationMs}ms`,
        limit,
        response.durationMs,
      );
    }

    return { output: { durationMs: response.durationMs }, artifacts: [] };
  }

  throw new StepExecutionError(
    'STEP_UNSUPPORTED',
    `Unsupported api step: ${match.definition.pattern}`,
    'error',
  );
}
