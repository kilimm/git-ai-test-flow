// 本文件所有改动要求遵循 agent-rules 规范
import { RUN_LIMITS } from '@gait/shared';
import type { ParsedFeature, ParsedScenario, ParsedStep } from '../gherkin/parse.js';
import { STEP_TYPE_BY_NAME } from '../steps/registry.js';
import type { StepRegistry } from '../steps/registry.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { DbAdapter } from '../db/types.js';
import type { HttpExecutor } from '../http/executor.js';
import type { UiDriver } from '../ui/driver.js';
import { CaseUiSession } from './ui-session.js';
import { executeStep } from './step-executor.js';
import type {
  ExecutionEnvironment,
  ScenarioIdentity,
  ScenarioRunResult,
  ScenarioStepRecord,
  StepOutcome,
  StepResultSink,
  StepRuntime,
} from './types.js';

export interface ScenarioRunOptions {
  featurePath: string;
  feature: ParsedFeature;
  scenario: ParsedScenario;
  stepRegistry: StepRegistry;
  environment: ExecutionEnvironment;
  http: HttpExecutor;
  db: DbAdapter | null;
  suiteRoot: string;
  artifacts: ArtifactStore;
  uiFactory: (() => Promise<UiDriver>) | null;
  identity: ScenarioIdentity;
  variableRoots: StepRuntime['variables'];
  apiAgent: StepRuntime['apiAgent'];
  sink: StepResultSink;
  signal?: AbortSignal;
  caseTimeoutMs?: number;
}

const EMPTY_SINK: StepResultSink = {
  async start() {
    return '';
  },
  async finish() {
    return;
  },
};

function mergedSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => {
    controller.abort();
  };

  external?.addEventListener('abort', onExternalAbort, { once: true });

  return {
    signal:
      external === undefined ? controller.signal : AbortSignal.any([external, controller.signal]),
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * 顺序执行 Background + Scenario 步骤：
 * - 断言失败立即停止后续步骤；
 * - 每一步先创建 step_result 行，再执行并回填产物；
 * - 单场景超时或外部取消会中止 HTTP/UI/脚本并记录已执行步骤。
 */
export async function runScenario(options: ScenarioRunOptions): Promise<ScenarioRunResult> {
  const startedAt = Date.now();
  const steps: ParsedStep[] = [...options.feature.backgroundSteps, ...options.scenario.steps];
  const records: ScenarioStepRecord[] = [];
  const timeoutMs = Math.min(
    options.caseTimeoutMs ??
      options.environment.caseTimeoutMs ??
      RUN_LIMITS.DEFAULT_CASE_TIMEOUT_MS,
    RUN_LIMITS.RUN_TIMEOUT_MS,
  );
  const timeout = mergedSignal(options.signal, timeoutMs);
  const uiSession = options.uiFactory === null ? null : new CaseUiSession(options.uiFactory);
  const runtime: StepRuntime = {
    variables: options.variableRoots,
    environment: options.environment,
    http: options.http,
    db: options.db,
    suiteRoot: options.suiteRoot,
    artifacts: options.artifacts,
    uiFactory: uiSession === null ? null : () => uiSession.get(),
    ui: null,
    apiAgent: options.apiAgent,
    signal: timeout.signal,
    headers: {},
    lastResponse: null,
    identity: options.identity,
  };
  let failure: { status: ScenarioStepRecord['status']; code: string; message: string } | null =
    null;

  try {
    for (const [index, step] of steps.entries()) {
      if (timeout.signal.aborted) {
        break;
      }

      const match = options.stepRegistry.match(step.text);
      const type = STEP_TYPE_BY_NAME[match?.definition.name ?? ''] ?? match?.type ?? 'builtin';
      const stepResultId = await options.sink.start({
        index: index + 1,
        keyword: step.keyword,
        text: step.text,
        type,
      });

      runtime.artifacts = options.artifacts.withScope({ stepResultId });
      let outcome: StepOutcome;

      if (match === undefined) {
        outcome = {
          status: 'failed',
          type: 'builtin',
          durationMs: 0,
          output: {},
          error: { code: 'UNKNOWN_STEP', message: `Unknown step: ${step.text}` },
          artifacts: [],
        };
      } else {
        outcome = await executeStep(step, match, runtime, index + 1);
      }

      const record: ScenarioStepRecord = {
        index: index + 1,
        keyword: step.keyword,
        text: step.text,
        type: outcome.type,
        status: outcome.status,
        durationMs: outcome.durationMs,
        error: outcome.error,
        artifacts: outcome.artifacts,
        output: outcome.output,
      };

      records.push(record);
      await options.sink.finish(stepResultId, record);

      if (outcome.status === 'failed' || outcome.status === 'error') {
        failure = {
          status: outcome.status,
          code: outcome.error?.code ?? 'STEP_FAILED',
          message: outcome.error?.message ?? 'Step failed',
        };
        break;
      }
    }
  } finally {
    timeout.cleanup();
  }

  const canceled = options.signal?.aborted === true;
  const timedOut = timeout.timedOut();
  const status: ScenarioRunResult['status'] = canceled
    ? 'canceled'
    : timedOut
      ? 'error'
      : failure === null
        ? 'passed'
        : failure.status;
  const errorCode = canceled ? 'RUN_CANCELED' : timedOut ? 'RUN_TIMEOUT' : (failure?.code ?? null);
  const errorMessage = canceled
    ? 'Run was canceled'
    : timedOut
      ? `Scenario exceeded ${timeoutMs}ms`
      : (failure?.message ?? null);
  const uiResult = uiSession === null ? null : await uiSession.finish(status !== 'passed');

  return {
    status,
    durationMs: Date.now() - startedAt,
    errorCode,
    errorMessage,
    steps: records,
    trace: uiResult?.trace ?? null,
    consoleMessages: uiResult?.consoleMessages ?? [],
    failureScreenshot: uiResult?.failureScreenshot ?? null,
  };
}

/** 供测试与编排器构造默认 sink。 */
export { EMPTY_SINK };
