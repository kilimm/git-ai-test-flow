// 本文件所有改动要求遵循 agent-rules 规范
import { RUN_ERROR_CODE } from '@gait/shared';
import type {
  AttributionResult,
  EvidenceHistoryEntry,
  EvidencePack,
  EvidenceRerun,
  EvidenceSignals,
  EvidenceStep,
} from '@gait/shared';

export interface RuleSignals {
  runErrorCode: string | null;
  environmentHealthy: boolean | null;
  environmentErrorCode: string | null;
  versionMatch: boolean | null;
  failedStep: EvidenceStep | null;
  caseErrorMessage: string | null;
  history: EvidenceHistoryEntry[];
  rerun: EvidenceRerun | null;
  signals: EvidenceSignals;
  allowedRefs: string[];
}

const ENVIRONMENT_ERROR_CODES = new Set<string>([
  RUN_ERROR_CODE.ENV_UNHEALTHY,
  RUN_ERROR_CODE.ENV_VERSION_MISMATCH,
  RUN_ERROR_CODE.DB_CONNECTION_FAILED,
  RUN_ERROR_CODE.DB_NOT_CONFIGURED,
  RUN_ERROR_CODE.FIXTURE_FAILED,
]);

function pickRefs(
  candidates: readonly (string | null | undefined)[],
  allowed: readonly string[],
): string[] {
  const allowedSet = new Set(allowed);
  const refs = candidates.filter(
    (candidate): candidate is string => typeof candidate === 'string' && allowedSet.has(candidate),
  );

  return [...new Set(refs)].slice(0, 8);
}

function result(
  verdict: AttributionResult['verdict'],
  confidence: number,
  rootCause: string,
  evidenceRefs: string[],
  options: {
    suggestedFix?: string | null;
    testRepairAllowed?: boolean;
    source?: AttributionResult['source'];
  } = {},
): AttributionResult {
  return {
    verdict,
    confidence,
    rootCause,
    evidenceRefs,
    suggestedFix: options.suggestedFix ?? null,
    testRepairAllowed:
      verdict === 'test_bug' && confidence >= 0.7 && (options.testRepairAllowed ?? true),
    source: options.source ?? 'rule',
    conflict: null,
  };
}

/**
 * 规则优先归因（规格 13.2）：
 * 重跑 → 环境/版本 → DB → 选择器改名 → 历史基线 → 断言关联 → 预存在/证据不足。
 */
export function decideByRules(input: RuleSignals): AttributionResult {
  const rerun = input.rerun;
  const failedStep = input.failedStep;
  const rerunRef = rerun !== null && rerun.attempted ? 'rerun' : null;
  const stepRef = failedStep === null ? null : `step:${failedStep.index}`;
  const errorRef =
    failedStep?.error === undefined || failedStep?.error === null
      ? null
      : `error:${failedStep.error.code}`;
  const historyPassed = input.history.find(
    (entry) => entry.caseStatus === 'passed' || entry.status === 'succeeded',
  );
  const historyFailed = input.history.find(
    (entry) => entry.caseStatus === 'failed' || entry.caseStatus === 'error',
  );
  const historyPassedRef = historyPassed === undefined ? null : `history:${historyPassed.runId}`;
  const historyFailedRef = historyFailed === undefined ? null : `history:${historyFailed.runId}`;
  const diffRef = input.allowedRefs.find((ref) => ref.startsWith('diff:')) ?? null;

  // 1. 重跑通过 → flaky，不修复。
  if (rerun !== null && rerun.attempted && rerun.passed) {
    return result(
      'flaky',
      0.92,
      '同一用例重跑后通过，判定为偶发失败（flaky）',
      pickRefs([rerunRef, stepRef], input.allowedRefs),
      { source: 'rerun' },
    );
  }

  // 2. 环境不可达/健康检查失败。
  if (input.runErrorCode !== null && ENVIRONMENT_ERROR_CODES.has(input.runErrorCode)) {
    return result(
      'env_issue',
      0.95,
      `执行环境异常（${input.runErrorCode}），失败与产品代码无关`,
      pickRefs([errorRef, 'environment'], input.allowedRefs),
    );
  }

  if (
    input.environmentErrorCode !== null &&
    ENVIRONMENT_ERROR_CODES.has(input.environmentErrorCode)
  ) {
    return result(
      'env_issue',
      0.9,
      `环境或测试数据准备失败（${input.environmentErrorCode}）`,
      pickRefs([errorRef, 'environment'], input.allowedRefs),
    );
  }

  if (input.environmentHealthy === false) {
    return result(
      'env_issue',
      0.9,
      '环境健康检查失败，先修复环境再重跑',
      pickRefs(['environment', errorRef], input.allowedRefs),
    );
  }

  // 3. 版本不一致：优先环境问题，报告标注版本差异。
  if (input.versionMatch === false) {
    return result(
      'env_issue',
      0.65,
      '环境实际部署版本与目标 commit 不一致，失败可能来自版本漂移',
      pickRefs(['environment', errorRef], input.allowedRefs),
      { source: 'rule' },
    );
  }

  // 4. 选择器/路由改名且产品代码有对应变更 → test_bug。
  if (
    input.signals.selectorChanged &&
    input.signals.productFilesChanged &&
    failedStep?.type === 'ui'
  ) {
    return result(
      'test_bug',
      0.82,
      '失败步骤使用的选择器在产品代码中已变更，属于用例过期',
      pickRefs([stepRef, diffRef, errorRef], input.allowedRefs),
      {
        suggestedFix: '更新 feature 中的选择器，使其与产品代码的新选择器一致',
      },
    );
  }

  // 5. 历史通过 + 当前失败 + 用例未改 → 高置信 code_bug。
  if (historyPassed !== undefined && !input.signals.testFilesChanged && failedStep !== null) {
    return result(
      'code_bug',
      0.82,
      '同一用例在历史基线通过、当前 commit 失败，且用例文件未变更',
      pickRefs([stepRef, historyPassedRef, diffRef, errorRef], input.allowedRefs),
    );
  }

  // 6. 失败断言涉及本次变更代码 → code_bug（确定）或 unknown（弱关联）。
  if (input.signals.codeTouchConfidence >= 0.6) {
    return result(
      'code_bug',
      0.74,
      '失败步骤涉及的接口/标识符出现在本次产品代码变更中',
      pickRefs([stepRef, diffRef, errorRef], input.allowedRefs),
    );
  }

  if (input.signals.codeTouchConfidence >= 0.4) {
    return result(
      'unknown',
      0.45,
      '失败步骤与本次变更存在弱关联，证据不足，需要人工确认',
      pickRefs([stepRef, diffRef, errorRef], input.allowedRefs),
    );
  }

  // 7. 历史与当前都失败，且用例未改 → 预存在问题或 flaky，需重跑/人工。
  if (historyFailed !== undefined && !input.signals.testFilesChanged && failedStep !== null) {
    return result(
      'unknown',
      rerun?.attempted === true ? 0.5 : 0.35,
      rerun?.attempted === true
        ? '历史与当前均失败且重跑未通过，可能是预存在问题，需要人工确认'
        : '历史与当前均失败，可能是预存在问题或 flaky，建议重跑确认',
      pickRefs([stepRef, historyFailedRef], input.allowedRefs),
    );
  }

  // 8. 证据不足。
  if (failedStep === null && input.caseErrorMessage === null) {
    return result('unknown', 0.2, '没有可用的失败步骤或错误信息，无法归因', [], {
      source: 'fallback',
    });
  }

  return result(
    'unknown',
    0.3,
    input.signals.testFilesChanged
      ? '用例文件已变更且缺少足够基线证据，需人工确认是否为用例问题'
      : '现有证据不足以区分产品缺陷与用例问题，需人工确认',
    pickRefs([stepRef, errorRef, diffRef], input.allowedRefs),
    { source: 'fallback' },
  );
}

export function ruleSignalsFromEvidence(
  pack: EvidencePack,
  options: {
    runErrorCode?: string | null;
    environmentErrorCode?: string | null;
    allowedRefs: string[];
  },
): RuleSignals {
  const failedStep =
    pack.steps.find((step) => step.status === 'failed' || step.status === 'error') ?? null;

  return {
    runErrorCode: options.runErrorCode ?? null,
    environmentHealthy: pack.environment.healthy,
    environmentErrorCode: options.environmentErrorCode ?? null,
    versionMatch: pack.environment.versionMatch,
    failedStep,
    caseErrorMessage: pack.case.errorMessage,
    history: pack.history,
    rerun: pack.rerun,
    signals: pack.signals,
    allowedRefs: options.allowedRefs,
  };
}
