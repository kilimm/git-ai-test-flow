// 本文件所有改动要求遵循 agent-rules 规范
import { ANALYSIS_LIMITS } from '@gait/shared';
import type {
  RepairGuardFinding,
  RepairGuardInput,
  RepairGuardResult,
  RepairGuardStatus,
} from '@gait/shared';

const SCENARIO_PATTERN = /^\s*(?:Scenario|Scenario Outline):/gm;
const THEN_PATTERN = /^\s*Then\b/gm;
const AGENT_PATTERN = /\[agent\]/i;
const SKIP_PATTERN = /@(?:skip|quarantine)\b/;

function count(pattern: RegExp, value: string): number {
  return (value.match(pattern) ?? []).length;
}

function scenarioLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(Scenario|Scenario Outline):/.test(line));
}

function thenLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^Then\b/.test(line));
}

function changedLineRatio(original: string, patched: string): number {
  const originalLines = original.split('\n');
  const patchedLines = patched.split('\n');
  const length = Math.max(originalLines.length, patchedLines.length, 1);
  let changed = 0;

  for (let index = 0; index < length; index += 1) {
    if ((originalLines[index] ?? '') !== (patchedLines[index] ?? '')) {
      changed += 1;
    }
  }

  return changed / length;
}

function featurePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');

  return (
    normalized.startsWith('features/') &&
    normalized.endsWith('.feature') &&
    !normalized.includes('../')
  );
}

function add(
  findings: RepairGuardFinding[],
  severity: RepairGuardFinding['severity'],
  code: string,
  message: string,
): void {
  findings.push({ code, severity, message });
}

/**
 * 修复 guard（规格 13.5）：
 * - P0 只允许对高置信 test_bug 生成建议；
 * - 只允许修改 features/**，禁止 steps/templates/产品代码；
 * - 场景数、Then 数不减少，禁止确定性断言替换为 agent；
 * - 预期值变化必须有关联代码变更证据；
 * - 单次最多 1 个场景、5 个步骤或 20% 内容；
 * - 最多 2 次修复尝试。
 */
export function evaluateRepairGuard(input: RepairGuardInput): RepairGuardResult {
  const findings: RepairGuardFinding[] = [];
  let humanRequired = false;

  if (!input.highConfidenceTestBug) {
    add(
      findings,
      'error',
      'NOT_HIGH_CONFIDENCE_TEST_BUG',
      '只有高置信 test_bug 才允许生成修复建议',
    );
  }

  if (input.priorAttempts >= 2) {
    add(findings, 'error', 'REPAIR_LIMIT_REACHED', '同一个用例最多修复 2 次');
  }

  if (input.patches.length === 0) {
    add(findings, 'error', 'EMPTY_PATCH', '修复没有包含任何文件变更');
  }

  if (input.patches.length > 1) {
    add(findings, 'error', 'TOO_MANY_FILES', '单次修复只允许修改 1 个 feature 文件');
  }

  for (const patch of input.patches) {
    if (!featurePath(patch.path)) {
      add(
        findings,
        'error',
        'FORBIDDEN_PATH',
        `只允许修改 features/**.feature，禁止修改 ${patch.path}`,
      );
      continue;
    }

    if (/^(steps|templates|scripts)\//.test(patch.path)) {
      add(findings, 'error', 'FORBIDDEN_PATH', '禁止修改 steps/templates/scripts');
    }

    const originalScenarios = scenarioLines(patch.originalContent);
    const patchedScenarios = scenarioLines(patch.patchedContent);

    if (patchedScenarios.length < originalScenarios.length) {
      add(findings, 'error', 'SCENARIO_REMOVED', '修复不得删除场景');
    }

    if (patchedScenarios.length > originalScenarios.length && originalScenarios.length > 0) {
      add(findings, 'error', 'SCENARIO_ADDED', '单次修复最多修改 1 个场景，不允许新增场景');
    }

    const originalThen = thenLines(patch.originalContent);
    const patchedThen = thenLines(patch.patchedContent);

    if (patchedThen.length < originalThen.length) {
      add(findings, 'error', 'ASSERTION_REMOVED', '修复不得删除 Then 断言');
    }

    const changedThen = originalThen.some((original, index) => {
      return patchedThen[index] !== undefined && original !== patchedThen[index];
    });

    if (changedThen) {
      if (!input.codeEvidenceAvailable) {
        add(
          findings,
          'error',
          'EXPECTATION_CHANGED_WITHOUT_EVIDENCE',
          '修改断言预期值必须引用产品代码变更证据',
        );
      } else {
        add(
          findings,
          'warning',
          'EXPECTATION_CHANGED_REQUIRES_APPROVAL',
          '修改断言预期值属于高风险修复，必须人工批准',
        );
        humanRequired = true;
      }
    }

    if (
      !AGENT_PATTERN.test(patch.originalContent) &&
      AGENT_PATTERN.test(patch.patchedContent) &&
      patchedThen.length <= originalThen.length
    ) {
      add(findings, 'error', 'AGENT_REPLACEMENT', '禁止把确定性断言替换为 agent 断言');
    }

    const addedSkip =
      SKIP_PATTERN.test(patch.patchedContent) && !SKIP_PATTERN.test(patch.originalContent);

    if (addedSkip) {
      add(findings, 'warning', 'SKIP_ADDED', '新增 @skip/@quarantine 需要人工批准');
      humanRequired = true;
    }

    const originalSteps = count(THEN_PATTERN, patch.originalContent);
    const patchedSteps = count(THEN_PATTERN, patch.patchedContent);
    const stepDelta = Math.abs(patchedSteps - originalSteps);
    const ratio = changedLineRatio(patch.originalContent, patch.patchedContent);

    if (
      stepDelta > ANALYSIS_LIMITS.MAX_REPAIR_STEPS &&
      ratio > ANALYSIS_LIMITS.MAX_REPAIR_CONTENT_RATIO
    ) {
      add(
        findings,
        'error',
        'REPAIR_SCOPE_EXCEEDED',
        `单次修复最多修改 ${ANALYSIS_LIMITS.MAX_REPAIR_STEPS} 个步骤或 ${Math.round(
          ANALYSIS_LIMITS.MAX_REPAIR_CONTENT_RATIO * 100,
        )}% 内容`,
      );
    }

    if (count(SCENARIO_PATTERN, patch.patchedContent) > 1 && originalScenarios.length <= 1) {
      add(findings, 'error', 'REPAIR_SCOPE_EXCEEDED', '单次修复最多涉及 1 个场景');
    }
  }

  const hasError = findings.some((finding) => finding.severity === 'error');
  const status: RepairGuardStatus = hasError
    ? 'blocked'
    : humanRequired || findings.length > 0
      ? 'human_required'
      : 'allowed';

  return { status, findings };
}

/** P0 只生成建议：没有实际 patch 时一律要求人工复核，不自动应用。 */
export function suggestionOnlyGuard(rationale: string): RepairGuardResult {
  return {
    status: 'human_required',
    findings: [
      {
        code: 'SUGGESTION_ONLY',
        severity: 'warning',
        message: 'P0 仅生成修复建议，不自动修改 Suite 或产品代码，需人工确认后处理',
      },
      {
        code: 'RATIONALE_PRESENT',
        severity: 'warning',
        message: rationale.slice(0, 1_000),
      },
    ],
  };
}
