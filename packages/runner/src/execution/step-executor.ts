// 本文件所有改动要求遵循 agent-rules 规范
import { AppError } from '@gait/config';
import type { StoredArtifact } from '../artifacts/artifact-store.js';
import { STEP_TYPE_BY_NAME } from '../steps/registry.js';
import type { StepMatch, StepDefinitionInput } from '../steps/registry.js';
import { AssertionError } from '../http/assertions.js';
import { UiDriverError } from '../ui/driver.js';
import { VisualAgentUnavailableError, VisualAssertionError } from '../ui/visual-agent.js';
import { AbortedError, delay } from '../run/concurrency.js';
import { executeApiStep } from './api-steps.js';
import { executeDbStep } from './db-steps.js';
import { executeUiStep } from './ui-steps.js';
import { runSuiteScript } from './script-step.js';
import type { ParsedStep } from '../gherkin/parse.js';
import { StepExecutionError } from './types.js';
import type { StepOutcome, StepRuntime } from './types.js';
import type { StepExecutionType } from '@gait/shared';

const API_STEPS = new Set([
  'send-request',
  'send-json-request',
  'set-header',
  'store-response-field',
  'response-status',
  'response-header',
  'response-jsonpath',
  'response-json-schema',
  'response-error-code',
  'response-time',
]);

const DB_STEPS = new Set([
  'test-database-prepared',
  'db-empty',
  'db-row-count',
  'db-row-count-plural',
  'db-row-count-where',
  'db-row-count-where-plural',
  'db-query-row-count',
  'db-query-contains',
]);

const UI_STEPS = new Set([
  'open-page',
  'enter-credentials',
  'enter-explicit-credentials',
  'logged-in-as',
  'redirected-to',
  'stay-on-page',
  'see-error',
  'ui-click',
  'ui-fill',
  'ui-contains',
  'ui-visible',
]);

function typeOf(name: string, match: StepMatch): StepExecutionType {
  const mapped = STEP_TYPE_BY_NAME[name];

  if (mapped !== undefined) {
    return mapped;
  }

  return match.type;
}

function normalizeError(error: unknown): Pick<StepOutcome, 'status' | 'error'> {
  if (error instanceof AssertionError) {
    return { status: 'failed', error: { code: error.code, message: error.message } };
  }

  if (error instanceof StepExecutionError) {
    return { status: error.outcome, error: { code: error.code, message: error.message } };
  }

  if (error instanceof UiDriverError) {
    return { status: 'failed', error: { code: 'UI_STEP_FAILED', message: error.message } };
  }

  if (error instanceof VisualAgentUnavailableError) {
    return { status: 'error', error: { code: error.code, message: error.message } };
  }

  if (error instanceof VisualAssertionError) {
    return { status: 'failed', error: { code: error.code, message: error.message } };
  }

  if (error instanceof AbortedError) {
    return { status: 'error', error: { code: 'RUN_CANCELED', message: error.message } };
  }

  if (error instanceof AppError) {
    return {
      status: 'error',
      error: {
        code: error.code,
        message: error.message.slice(0, 500),
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    status: 'error',
    error: { code: 'STEP_FAILED', message: message.slice(0, 500) },
  };
}

/**
 * 单步执行入口：根据 StepRegistry 匹配到的定义分派到 API/DB/UI/脚本执行器。
 * 返回统一 outcome，不向调用方抛出断言错误（取消与内部错误也会转为 error）。
 */
export async function executeStep(
  step: ParsedStep,
  match: StepMatch,
  runtime: StepRuntime,
  stepIndex: number,
): Promise<StepOutcome> {
  const name = match.definition.name;
  const type = typeOf(name, match);
  const startedAt = Date.now();

  try {
    if (runtime.signal?.aborted === true) {
      throw new StepExecutionError('RUN_CANCELED', 'Run was canceled', 'error');
    }

    if (name === 'environment-ready') {
      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: { ready: true },
        error: null,
        artifacts: [],
      };
    }

    if (name === 'wait') {
      const milliseconds = Number(match.params[0] ?? 0);

      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 300_000) {
        throw new StepExecutionError('WAIT_INVALID', 'Wait duration is invalid', 'failed');
      }

      await delay(milliseconds, runtime.signal);

      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: { waitedMs: milliseconds },
        error: null,
        artifacts: [],
      };
    }

    if (name === 'agent-step') {
      const instruction = match.params[0]?.trim() ?? '';

      if (instruction.length === 0) {
        throw new StepExecutionError('AGENT_INSTRUCTION_MISSING', 'Agent step is empty', 'failed');
      }

      const driver = runtime.ui ?? (runtime.uiFactory === null ? null : await runtime.uiFactory());

      if (driver === null) {
        throw new StepExecutionError(
          'VISION_UNAVAILABLE',
          'UI driver is not configured for this scenario',
          'error',
        );
      }

      runtime.ui = driver;
      const visualAgent = driver.visualAgent;

      if (visualAgent === undefined) {
        throw new StepExecutionError(
          'VISION_UNAVAILABLE',
          'Vision agent is not configured; Midscene and a vision LLM Profile are required',
          'error',
        );
      }

      const mode = step.keyword === 'Then' ? 'assert' : 'act';
      const result =
        mode === 'assert'
          ? await visualAgent.assert(instruction)
          : await visualAgent.act(instruction);
      const artifacts: StoredArtifact[] = [];
      const screenshot = await driver.screenshot();

      artifacts.push(
        runtime.artifacts.writeBuffer(
          'screenshot',
          `agent-${stepIndex}-${mode}`,
          screenshot,
          'image/png',
          { instruction, mode },
        ),
      );

      return {
        status: 'passed',
        type: 'agent',
        durationMs: Date.now() - startedAt,
        output: { instruction, mode, description: result.description },
        error: null,
        artifacts,
      };
    }

    if (API_STEPS.has(name)) {
      const result = await executeApiStep(name, match.params, step, match, runtime, stepIndex);

      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: result.output,
        error: null,
        artifacts: result.artifacts,
      };
    }

    if (DB_STEPS.has(name)) {
      const result = await executeDbStep(name, match.params, match, runtime, stepIndex);

      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: result.output,
        error: null,
        artifacts: result.artifacts,
      };
    }

    if (UI_STEPS.has(name)) {
      const result = await executeUiStep(name, match.params, match, runtime, stepIndex);

      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: result.output,
        error: null,
        artifacts: result.artifacts,
      };
    }

    if (match.type === 'script' || match.type === 'template') {
      const definition: StepDefinitionInput = match.definition;
      const result = await runSuiteScript(runtime, definition, stepIndex, step.text, match.params);

      return {
        status: 'passed',
        type,
        durationMs: Date.now() - startedAt,
        output: result.output,
        error: null,
        artifacts: [],
      };
    }

    throw new StepExecutionError(
      'STEP_UNSUPPORTED',
      `No executor is registered for step: ${name}`,
      'error',
    );
  } catch (error) {
    const normalized = normalizeError(error);

    return {
      status: normalized.status,
      type,
      durationMs: Date.now() - startedAt,
      output: {},
      error: normalized.error,
      artifacts: [],
    };
  }
}
