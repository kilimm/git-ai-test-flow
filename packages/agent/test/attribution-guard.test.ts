// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { evaluateRepairGuard, suggestionOnlyGuard } from '../src/attribution/repair-guard.js';
import type { RepairGuardInput } from '@gait/shared';

const ORIGINAL = [
  'Feature: Posts',
  '',
  '  Scenario: create post',
  '    When I send a POST request to "/api/posts" with JSON:',
  '      """json',
  '      {"title": "demo"}',
  '      """',
  '    Then the response status should be 201',
  '    And the response body at "$.title" should be "demo"',
].join('\n');

const PATCHED = ORIGINAL.replace('"/api/posts"', '"/api/v2/posts"');

function input(overrides: Partial<RepairGuardInput> = {}): RepairGuardInput {
  return {
    patches: [
      {
        path: 'features/api/posts.feature',
        originalContent: ORIGINAL,
        patchedContent: PATCHED,
      },
    ],
    codeEvidenceAvailable: true,
    highConfidenceTestBug: true,
    priorAttempts: 0,
    ...overrides,
  };
}

describe('修复 guard', () => {
  it('允许高置信 test_bug 的路由更新', () => {
    const result = evaluateRepairGuard(input());

    expect(result.status).toBe('allowed');
    expect(result.findings).toEqual([]);
  });

  it('禁止修改 steps/ 或产品代码', () => {
    const result = evaluateRepairGuard(
      input({
        patches: [
          {
            path: 'steps/api.ts',
            originalContent: 'export const step = 1;',
            patchedContent: 'export const step = 2;',
          },
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'FORBIDDEN_PATH')).toBe(true);
  });

  it('禁止删除场景', () => {
    const result = evaluateRepairGuard(
      input({
        patches: [
          {
            path: 'features/api/posts.feature',
            originalContent: `${ORIGINAL}\n\n  Scenario: second\n    Then the response status should be 200`,
            patchedContent: ORIGINAL,
          },
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'SCENARIO_REMOVED')).toBe(true);
  });

  it('禁止删除 Then 断言', () => {
    const patched = ORIGINAL.split('\n')
      .filter((line) => !line.trim().startsWith('Then '))
      .join('\n');
    const result = evaluateRepairGuard(
      input({
        patches: [
          {
            path: 'features/api/posts.feature',
            originalContent: ORIGINAL,
            patchedContent: patched,
          },
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'ASSERTION_REMOVED')).toBe(true);
  });

  it('预期值变化必须有代码证据', () => {
    const patched = ORIGINAL.replace('should be 201', 'should be 200');
    const result = evaluateRepairGuard(
      input({
        codeEvidenceAvailable: false,
        patches: [
          {
            path: 'features/api/posts.feature',
            originalContent: ORIGINAL,
            patchedContent: patched,
          },
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(
      result.findings.some((finding) => finding.code === 'EXPECTATION_CHANGED_WITHOUT_EVIDENCE'),
    ).toBe(true);
  });

  it('新增 @skip 需要人工批准', () => {
    const result = evaluateRepairGuard(
      input({
        patches: [
          {
            path: 'features/api/posts.feature',
            originalContent: ORIGINAL,
            patchedContent: `@skip\n${ORIGINAL}`,
          },
        ],
      }),
    );

    expect(result.status).toBe('human_required');
    expect(result.findings.some((finding) => finding.code === 'SKIP_ADDED')).toBe(true);
  });

  it('超过 2 次修复尝试后拒绝', () => {
    const result = evaluateRepairGuard(input({ priorAttempts: 2 }));

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'REPAIR_LIMIT_REACHED')).toBe(true);
  });

  it('低置信 test_bug 不生成修复', () => {
    const result = evaluateRepairGuard(input({ highConfidenceTestBug: false }));

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'NOT_HIGH_CONFIDENCE_TEST_BUG')).toBe(
      true,
    );
  });

  it('多文件修复被拒绝', () => {
    const result = evaluateRepairGuard(
      input({
        patches: [
          {
            path: 'features/api/posts.feature',
            originalContent: ORIGINAL,
            patchedContent: PATCHED,
          },
          {
            path: 'features/api/items.feature',
            originalContent: ORIGINAL,
            patchedContent: PATCHED,
          },
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.findings.some((finding) => finding.code === 'TOO_MANY_FILES')).toBe(true);
  });

  it('P0 建议一律要求人工复核', () => {
    const result = suggestionOnlyGuard('更新选择器');

    expect(result.status).toBe('human_required');
    expect(result.findings.some((finding) => finding.code === 'SUGGESTION_ONLY')).toBe(true);
  });
});
