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
  aggregated: boolean;
  canceled: boolean;
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
    aggregated: false,
    canceled: false,
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
 * Graph B 执行主链（M5 范围）：
 * prepare_workspace → verify_environment → prepare_test_data → discover_cases
 * → run_cases → aggregate。
 *
 * checkpoint 以 `run:<runId>` 为 thread_id；正常情况节点按顺序执行，
 * Worker 崩溃后重试时 LangGraph 从已完成的节点之后继续。
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
      (state: RunAnnotationState) => (state.state.executed ? 'aggregate' : 'finalize_failed'),
      { aggregate: 'aggregate', finalize_failed: 'finalize_failed' },
    )
    .addEdge('aggregate', END)
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
