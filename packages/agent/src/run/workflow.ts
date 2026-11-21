// 本文件所有改动要求遵循 agent-rules 规范
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { RunStageResult } from '@gait/runner';

export interface RunWorkflowExecutor {
  prepareWorkspace(): Promise<RunStageResult>;
  verifyEnvironment(): Promise<RunStageResult>;
  prepareTestData(): Promise<RunStageResult>;
  discoverCases(): Promise<RunStageResult>;
  runCases(): Promise<RunStageResult>;
  /** M6：失败用例重跑、归因、报告与通知；未实现时跳过。 */
  rerunFailedCases?(): Promise<RunStageResult>;
  analyzeRun?(): Promise<RunStageResult>;
  /** M9：应用通过 guard 的安全修复并重跑，失败不阻断报告。 */
  repairFailedCases?(): Promise<RunStageResult>;
  generateReport?(): Promise<RunStageResult>;
  notifyRun?(): Promise<RunStageResult>;
  aggregate(): Promise<RunStageResult>;
  fail(code: string, message: string): Promise<void>;
}

export interface RunWorkflowInput {
  runId: string;
  threadId?: string;
}

export interface RunWorkflowState {
  runId: string;
  prepared: boolean;
  verified: boolean;
  dataPrepared: boolean;
  discovered: boolean;
  executed: boolean;
  rerun: boolean;
  analyzed: boolean;
  repaired: boolean;
  aggregated: boolean;
  reported: boolean;
  notified: boolean;
  canceled: boolean;
  warnings: string[];
  failureCode: string | null;
  failureMessage: string | null;
  outcome: 'completed' | 'failed' | 'canceled';
}

export interface RunWorkflowResult {
  outcome: RunWorkflowState['outcome'];
  failureCode: string | null;
  failureMessage: string | null;
  state: RunWorkflowState;
}

const RunAnnotation = Annotation.Root({
  state: Annotation<RunWorkflowState>({
    reducer: (_previous, next) => next,
  }),
});

type RunAnnotationState = typeof RunAnnotation.State;

function initial(runId: string): RunWorkflowState {
  return {
    runId,
    prepared: false,
    verified: false,
    dataPrepared: false,
    discovered: false,
    executed: false,
    rerun: false,
    analyzed: false,
    repaired: false,
    aggregated: false,
    reported: false,
    notified: false,
    canceled: false,
    warnings: [],
    failureCode: null,
    failureMessage: null,
    outcome: 'failed',
  };
}

function failed(state: RunWorkflowState, result: RunStageResult): RunWorkflowState {
  return {
    ...state,
    canceled: result.canceled === true,
    failureCode: result.canceled === true ? 'RUN_CANCELED' : (result.code ?? 'RUN_FAILED'),
    failureMessage: result.message ?? 'Run stage failed',
    outcome: result.canceled === true ? 'canceled' : 'failed',
  };
}

async function safeStage(stage: () => Promise<RunStageResult>): Promise<RunStageResult> {
  try {
    return await stage();
  } catch (error) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: error instanceof Error ? error.message.slice(0, 500) : String(error),
    };
  }
}

/**
 * Graph B 执行与归因主链（M6）：
 * prepare_workspace → verify_environment → prepare_test_data → discover_cases
 * → run_cases → rerun_failed → analyze → aggregate → generate_report → notify。
 *
 * 归因/报告/通知失败不阻断已完成的执行结果；取消时跳过归因与通知。
 * checkpoint 以 `run:<runId>` 为 thread_id，Worker 崩溃后从已完成节点继续。
 */
export async function runRunWorkflow(
  executor: RunWorkflowExecutor,
  input: RunWorkflowInput,
  options: { checkpointer?: BaseCheckpointSaver } = {},
): Promise<RunWorkflowResult> {
  const graph = new StateGraph(RunAnnotation)
    .addNode('prepare_workspace', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.prepareWorkspace());

      if (result.ok) {
        return { state: { ...state.state, prepared: true } };
      }

      return { state: failed(state.state, result) };
    })
    .addNode('verify_environment', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.verifyEnvironment());

      if (result.ok) {
        return { state: { ...state.state, verified: true } };
      }

      return { state: failed(state.state, result) };
    })
    .addNode('prepare_test_data', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.prepareTestData());

      if (result.ok) {
        return { state: { ...state.state, dataPrepared: true } };
      }

      return { state: failed(state.state, result) };
    })
    .addNode('discover_cases', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.discoverCases());

      if (result.ok) {
        return { state: { ...state.state, discovered: true } };
      }

      return { state: failed(state.state, result) };
    })
    .addNode('run_cases', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.runCases());

      if (result.ok) {
        return {
          state: {
            ...state.state,
            executed: true,
            canceled: result.canceled === true,
          },
        };
      }

      return { state: failed(state.state, result) };
    })
    .addNode('rerun_failed', async (state: RunAnnotationState) => {
      const stage = executor.rerunFailedCases;

      if (stage === undefined || state.state.canceled) {
        return { state: { ...state.state, rerun: true } };
      }

      const result = await safeStage(() => stage.call(executor));

      return {
        state: {
          ...state.state,
          rerun: true,
          canceled: result.canceled === true,
          warnings:
            result.ok || result.canceled === true
              ? state.state.warnings
              : [...state.state.warnings, `rerun: ${result.message ?? result.code ?? 'failed'}`],
        },
      };
    })
    .addNode('analyze', async (state: RunAnnotationState) => {
      const stage = executor.analyzeRun;

      if (stage === undefined || state.state.canceled) {
        return { state: { ...state.state, analyzed: true } };
      }

      const result = await safeStage(() => stage.call(executor));

      return {
        state: {
          ...state.state,
          analyzed: true,
          warnings: result.ok
            ? state.state.warnings
            : [...state.state.warnings, `analyze: ${result.message ?? result.code ?? 'failed'}`],
        },
      };
    })
    .addNode('repair_failed', async (state: RunAnnotationState) => {
      const stage = executor.repairFailedCases;

      if (stage === undefined || state.state.canceled) {
        return { state: { ...state.state, repaired: true } };
      }

      const result = await safeStage(() => stage.call(executor));

      return {
        state: {
          ...state.state,
          repaired: true,
          canceled: result.canceled === true ? true : state.state.canceled,
          warnings: result.ok
            ? state.state.warnings
            : [...state.state.warnings, `repair: ${result.message ?? result.code ?? 'failed'}`],
        },
      };
    })
    .addNode('aggregate', async (state: RunAnnotationState) => {
      const result = await safeStage(() => executor.aggregate());

      if (!result.ok) {
        return { state: failed(state.state, result) };
      }

      return {
        state: {
          ...state.state,
          aggregated: true,
          outcome: state.state.canceled ? 'canceled' : 'completed',
        },
      };
    })
    .addNode('generate_report', async (state: RunAnnotationState) => {
      const stage = executor.generateReport;

      if (stage === undefined) {
        return { state: { ...state.state, reported: true } };
      }

      const result = await safeStage(() => stage.call(executor));

      return {
        state: {
          ...state.state,
          reported: true,
          warnings: result.ok
            ? state.state.warnings
            : [...state.state.warnings, `report: ${result.message ?? result.code ?? 'failed'}`],
        },
      };
    })
    .addNode('notify', async (state: RunAnnotationState) => {
      const stage = executor.notifyRun;

      if (stage === undefined) {
        return { state: { ...state.state, notified: true } };
      }

      const result = await safeStage(() => stage.call(executor));

      return {
        state: {
          ...state.state,
          notified: true,
          warnings: result.ok
            ? state.state.warnings
            : [...state.state.warnings, `notify: ${result.message ?? result.code ?? 'failed'}`],
        },
      };
    })
    .addNode('finalize_failed', async (state: RunAnnotationState) => {
      if (state.state.outcome === 'canceled') {
        // 用户取消保持 canceled，不覆盖为 failed。
        return { state: state.state };
      }

      await executor.fail(
        state.state.failureCode ?? 'RUN_FAILED',
        state.state.failureMessage ?? 'Run failed',
      );

      return { state: { ...state.state, outcome: 'failed' } };
    })
    .addEdge(START, 'prepare_workspace')
    .addConditionalEdges(
      'prepare_workspace',
      (state: RunAnnotationState) => {
        if (state.state.prepared) {
          return 'verify_environment';
        }

        return state.state.outcome === 'canceled' ? 'aggregate' : 'finalize_failed';
      },
      {
        verify_environment: 'verify_environment',
        aggregate: 'aggregate',
        finalize_failed: 'finalize_failed',
      },
    )
    .addConditionalEdges(
      'verify_environment',
      (state: RunAnnotationState) =>
        state.state.verified ? 'prepare_test_data' : 'finalize_failed',
      { prepare_test_data: 'prepare_test_data', finalize_failed: 'finalize_failed' },
    )
    .addConditionalEdges(
      'prepare_test_data',
      (state: RunAnnotationState) =>
        state.state.dataPrepared ? 'discover_cases' : 'finalize_failed',
      { discover_cases: 'discover_cases', finalize_failed: 'finalize_failed' },
    )
    .addConditionalEdges(
      'discover_cases',
      (state: RunAnnotationState) => (state.state.discovered ? 'run_cases' : 'finalize_failed'),
      { run_cases: 'run_cases', finalize_failed: 'finalize_failed' },
    )
    .addConditionalEdges(
      'run_cases',
      (state: RunAnnotationState) => (state.state.executed ? 'rerun_failed' : 'finalize_failed'),
      { rerun_failed: 'rerun_failed', finalize_failed: 'finalize_failed' },
    )
    .addConditionalEdges(
      'rerun_failed',
      (state: RunAnnotationState) => (state.state.canceled ? 'aggregate' : 'analyze'),
      { aggregate: 'aggregate', analyze: 'analyze' },
    )
    .addEdge('analyze', 'repair_failed')
    .addEdge('repair_failed', 'aggregate')
    .addConditionalEdges(
      'aggregate',
      (state: RunAnnotationState) => (state.state.canceled ? END : 'generate_report'),
      { [END]: END, generate_report: 'generate_report' },
    )
    .addEdge('generate_report', 'notify')
    .addEdge('notify', END)
    .addEdge('finalize_failed', END)
    .compile(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer });

  const state = await graph
    .invoke(
      { state: initial(input.runId) },
      { configurable: { thread_id: input.threadId ?? `run:${input.runId}` } },
    )
    .then((result) => result.state as RunWorkflowState);

  return {
    outcome: state.outcome === 'completed' && state.aggregated ? 'completed' : state.outcome,
    failureCode: state.failureCode,
    failureMessage: state.failureMessage,
    state,
  };
}
