// 本文件所有改动要求遵循 agent-rules 规范
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import type { RunStageResult } from '@gait/runner';
import { runRunWorkflow } from '../src/run/workflow.js';
import type { RunWorkflowExecutor } from '../src/run/workflow.js';

function ok(): RunStageResult {
  return { ok: true, code: null, message: null };
}

function failure(code: string): RunStageResult {
  return { ok: false, code, message: `${code} failed` };
}

function createExecutor(overrides: Partial<RunWorkflowExecutor> = {}): {
  executor: RunWorkflowExecutor;
  calls: string[];
} {
  const calls: string[] = [];
  const executor: RunWorkflowExecutor = {
    async prepareWorkspace() {
      calls.push('prepare');
      return ok();
    },
    async verifyEnvironment() {
      calls.push('verify');
      return ok();
    },
    async prepareTestData() {
      calls.push('data');
      return ok();
    },
    async discoverCases() {
      calls.push('discover');
      return ok();
    },
    async runCases() {
      calls.push('run');
      return ok();
    },
    async aggregate() {
      calls.push('aggregate');
      return ok();
    },
    async fail(code) {
      calls.push(`fail:${code}`);
    },
    ...overrides,
  };

  return { executor, calls };
}

describe('graph B run workflow', () => {
  it('runs stages in order and aggregates', async () => {
    const { executor, calls } = createExecutor();
    const result = await runRunWorkflow(executor, { runId: 'run-1' });

    expect(result.outcome).toBe('completed');
    expect(result.state.aggregated).toBe(true);
    expect(calls).toEqual(['prepare', 'verify', 'data', 'discover', 'run', 'aggregate']);
  });

  it('stops on environment failure and sets a failed run', async () => {
    const { executor, calls } = createExecutor({
      async verifyEnvironment() {
        calls.push('verify');
        return failure('ENV_UNHEALTHY');
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-2' });

    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('ENV_UNHEALTHY');
    expect(calls).toEqual(['prepare', 'verify', 'fail:ENV_UNHEALTHY']);
  });

  it('aggregates canceled runs without marking them failed', async () => {
    const { executor, calls } = createExecutor({
      async runCases() {
        calls.push('run');
        return {
          ok: true,
          code: 'RUN_CANCELED',
          message: 'Run canceled',
          canceled: true,
        };
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-3' });

    expect(result.outcome).toBe('canceled');
    expect(result.state.canceled).toBe(true);
    expect(calls).toEqual(['prepare', 'verify', 'data', 'discover', 'run', 'aggregate']);
  });

  it('runs rerun, analyze, report and notify after execution', async () => {
    const { executor, calls } = createExecutor({
      async rerunFailedCases() {
        calls.push('rerun');
        return ok();
      },
      async analyzeRun() {
        calls.push('analyze');
        return ok();
      },
      async generateReport() {
        calls.push('report');
        return ok();
      },
      async notifyRun() {
        calls.push('notify');
        return ok();
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-m6' });

    expect(result.outcome).toBe('completed');
    expect(result.state.analyzed).toBe(true);
    expect(result.state.reported).toBe(true);
    expect(result.state.notified).toBe(true);
    expect(calls).toEqual([
      'prepare',
      'verify',
      'data',
      'discover',
      'run',
      'rerun',
      'analyze',
      'aggregate',
      'report',
      'notify',
    ]);
  });

  it('skips analysis and notification when the run is canceled', async () => {
    const { executor, calls } = createExecutor({
      async runCases() {
        calls.push('run');
        return { ok: true, code: 'RUN_CANCELED', message: 'Run canceled', canceled: true };
      },
      async rerunFailedCases() {
        calls.push('rerun');
        return { ok: true, code: 'RUN_CANCELED', message: 'Run canceled', canceled: true };
      },
      async analyzeRun() {
        calls.push('analyze');
        return ok();
      },
      async generateReport() {
        calls.push('report');
        return ok();
      },
      async notifyRun() {
        calls.push('notify');
        return ok();
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-canceled' });

    expect(result.outcome).toBe('canceled');
    expect(calls).toEqual(['prepare', 'verify', 'data', 'discover', 'run', 'aggregate']);
  });

  it('analysis/report/notify failures are non-fatal warnings', async () => {
    const { executor } = createExecutor({
      async analyzeRun() {
        return failure('ANALYSIS_FAILED');
      },
      async generateReport() {
        return failure('REPORT_FAILED');
      },
      async notifyRun() {
        return failure('NOTIFICATION_FAILED');
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-warnings' });

    expect(result.outcome).toBe('completed');
    expect(result.state.warnings).toHaveLength(3);
    expect(result.state.warnings.join(' ')).toContain('ANALYSIS_FAILED');
  });

  it('skips rerun stage failures and still analyzes', async () => {
    const calls: string[] = [];
    const { executor } = createExecutor({
      async rerunFailedCases() {
        calls.push('rerun');
        return failure('RERUN_FAILED');
      },
      async analyzeRun() {
        calls.push('analyze');
        return ok();
      },
    });
    const result = await runRunWorkflow(executor, { runId: 'run-rerun-fail' });

    expect(result.outcome).toBe('completed');
    expect(calls).toEqual(['rerun', 'analyze']);
    expect(result.state.warnings.join(' ')).toContain('RERUN_FAILED');
  });

  it('persists checkpoints for a run thread', async () => {
    const saver = new MemorySaver();
    const { executor } = createExecutor();
    const result = await runRunWorkflow(
      executor,
      { runId: 'run-checkpoint', threadId: 'run:run-checkpoint' },
      { checkpointer: saver },
    );

    expect(result.outcome).toBe('completed');
    const tuple = await saver.getTuple({
      configurable: { thread_id: 'run:run-checkpoint' },
    });

    expect(tuple).toBeDefined();
    expect(tuple?.config.configurable?.thread_id).toBe('run:run-checkpoint');
  });
});
