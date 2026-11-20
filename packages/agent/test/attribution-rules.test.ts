// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { decideByRules } from '../src/attribution/rules.js';
import type { RuleSignals } from '../src/attribution/rules.js';
import type { EvidenceSignals, EvidenceStep } from '@gait/shared';

const EMPTY_SIGNALS: EvidenceSignals = {
  failedStepType: null,
  failedStepKeyword: null,
  failedStepText: null,
  endpoints: [],
  selectors: [],
  selectorChanged: false,
  testFilesChanged: false,
  productFilesChanged: false,
  codeTouchConfidence: 0,
};

function step(overrides: Partial<EvidenceStep> = {}): EvidenceStep {
  return {
    index: 1,
    keyword: 'Then',
    text: 'the response status should be 400',
    type: 'api',
    status: 'failed',
    durationMs: 10,
    error: { code: 'EXPECTED_STATUS', message: 'expected 400 but received 500' },
    output: {},
    ...overrides,
  };
}

function input(overrides: Partial<RuleSignals> = {}): RuleSignals {
  return {
    runErrorCode: null,
    environmentHealthy: true,
    environmentErrorCode: null,
    versionMatch: true,
    failedStep: step(),
    caseErrorMessage: 'expected 400 but received 500',
    history: [],
    rerun: null,
    signals: { ...EMPTY_SIGNALS },
    allowedRefs: [
      'environment',
      'step:1',
      'error:EXPECTED_STATUS',
      'diff:src/api/posts.ts',
      'diff:src/api/posts.ts:42',
      'history:run-old',
      'rerun',
    ],
    ...overrides,
  };
}

describe('规则归因矩阵', () => {
  it('重跑通过判定 flaky，不修复', () => {
    const result = decideByRules(
      input({
        rerun: {
          attempted: true,
          previousStatus: 'failed',
          previousErrorCode: 'EXPECTED_STATUS',
          passed: true,
          durationMs: 12,
        },
      }),
    );

    expect(result.verdict).toBe('flaky');
    expect(result.testRepairAllowed).toBe(false);
    expect(result.source).toBe('rerun');
  });

  it('Run 级环境错误判定 env_issue', () => {
    const result = decideByRules(input({ runErrorCode: 'ENV_UNHEALTHY' }));

    expect(result.verdict).toBe('env_issue');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.testRepairAllowed).toBe(false);
  });

  it('数据库连接失败判定 env_issue', () => {
    const result = decideByRules(input({ environmentErrorCode: 'DB_CONNECTION_FAILED' }));

    expect(result.verdict).toBe('env_issue');
    expect(result.evidenceRefs).toContain('environment');
  });

  it('环境健康检查失败判定 env_issue', () => {
    const result = decideByRules(input({ environmentHealthy: false }));

    expect(result.verdict).toBe('env_issue');
    expect(result.rootCause).toContain('环境');
  });

  it('版本不一致判定 env_issue 并保持不修复', () => {
    const result = decideByRules(input({ versionMatch: false }));

    expect(result.verdict).toBe('env_issue');
    expect(result.rootCause).toContain('版本');
    expect(result.testRepairAllowed).toBe(false);
  });

  it('选择器改名且有产品代码变更判定 test_bug', () => {
    const result = decideByRules(
      input({
        failedStep: step({
          type: 'ui',
          text: 'I click "old-login" button',
          error: { code: 'LOCATOR_TIMEOUT', message: 'waiting for selector "old-login"' },
        }),
        signals: {
          ...EMPTY_SIGNALS,
          failedStepType: 'ui',
          selectors: ['old-login'],
          selectorChanged: true,
          productFilesChanged: true,
        },
      }),
    );

    expect(result.verdict).toBe('test_bug');
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.testRepairAllowed).toBe(true);
    expect(result.suggestedFix).not.toBeNull();
  });

  it('历史通过 + 当前失败 + 用例未改判定 code_bug', () => {
    const result = decideByRules(
      input({
        history: [
          {
            runId: 'run-old',
            headSha: 'a'.repeat(40),
            status: 'succeeded',
            caseStatus: 'passed',
            classification: null,
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    );

    expect(result.verdict).toBe('code_bug');
    expect(result.testRepairAllowed).toBe(false);
    expect(result.evidenceRefs).toContain('history:run-old');
  });

  it('失败断言涉及变更代码判定 code_bug', () => {
    const result = decideByRules(
      input({
        signals: {
          ...EMPTY_SIGNALS,
          productFilesChanged: true,
          codeTouchConfidence: 0.7,
        },
      }),
    );

    expect(result.verdict).toBe('code_bug');
    expect(result.testRepairAllowed).toBe(false);
  });

  it('弱代码关联判定 unknown', () => {
    const result = decideByRules(
      input({
        signals: {
          ...EMPTY_SIGNALS,
          productFilesChanged: true,
          codeTouchConfidence: 0.4,
        },
      }),
    );

    expect(result.verdict).toBe('unknown');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('历史与当前都失败判定 unknown', () => {
    const result = decideByRules(
      input({
        history: [
          {
            runId: 'run-old',
            headSha: 'a'.repeat(40),
            status: 'failed',
            caseStatus: 'failed',
            classification: 'unknown',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    );

    expect(result.verdict).toBe('unknown');
    expect(result.rootCause).toContain('预存在');
  });

  it('历史失败但重跑过仍失败时置信度提高', () => {
    const result = decideByRules(
      input({
        history: [
          {
            runId: 'run-old',
            headSha: 'a'.repeat(40),
            status: 'failed',
            caseStatus: 'failed',
            classification: 'unknown',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
        rerun: {
          attempted: true,
          previousStatus: 'failed',
          previousErrorCode: 'EXPECTED_STATUS',
          passed: false,
          durationMs: 11,
        },
      }),
    );

    expect(result.verdict).toBe('unknown');
    expect(result.confidence).toBe(0.5);
  });

  it('没有失败步骤与错误信息时回退 unknown', () => {
    const result = decideByRules(input({ failedStep: null, caseErrorMessage: null }));

    expect(result.verdict).toBe('unknown');
    expect(result.source).toBe('fallback');
    expect(result.evidenceRefs).toEqual([]);
  });

  it('用例文件变更时不会仅凭历史判定 code_bug', () => {
    const result = decideByRules(
      input({
        history: [
          {
            runId: 'run-old',
            headSha: 'a'.repeat(40),
            status: 'succeeded',
            caseStatus: 'passed',
            classification: null,
            startedAt: 1,
            finishedAt: 2,
          },
        ],
        signals: { ...EMPTY_SIGNALS, testFilesChanged: true },
      }),
    );

    expect(result.verdict).toBe('unknown');
  });
});
