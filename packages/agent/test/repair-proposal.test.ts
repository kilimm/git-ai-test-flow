// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { AttributionResult, EvidencePack } from '@gait/shared';
import { proposeTestRepair, simplePatchDiff } from '../src/index.js';
import type { LlmClient } from '../src/index.js';

const attribution: AttributionResult = {
  verdict: 'test_bug',
  confidence: 0.86,
  rootCause: '选择器改名',
  evidenceRefs: ['step:1', 'diff:src/pages/posts.tsx:10'],
  suggestedFix: '更新选择器',
  testRepairAllowed: true,
  source: 'llm',
  conflict: null,
};

const original = [
  '@module:posts @layer:ui',
  'Feature: Posts',
  '  @case:UI-1',
  '  Scenario: list',
  '    When I click "button[data-testid=old-submit]"',
  '    Then the page should contain "ok"',
  '',
].join('\n');

function pack(): EvidencePack {
  return {
    version: 1,
    collectedAt: 1,
    run: {
      id: 'run-1',
      projectId: 'project-1',
      branch: 'main',
      baseSha: null,
      headSha: 'a'.repeat(40),
      deployedSha: 'a'.repeat(40),
      versionMatch: true,
      status: 'failed',
      trigger: 'manual',
    },
    environment: {
      id: 'env-1',
      name: 'staging',
      apiBaseUrl: 'http://127.0.0.1',
      versionMatch: true,
      deployedSha: 'a'.repeat(40),
      healthy: true,
    },
    case: {
      id: 'case-1',
      featurePath: 'features/posts.feature',
      scenarioName: 'list',
      line: 1,
      caseKey: 'UI-1',
      tags: [],
      layer: 'ui',
      status: 'failed',
      attempt: 2,
      errorMessage: 'selector missing',
      featureSource: original,
    },
    failedStepIndex: 1,
    steps: [],
    artifacts: [],
    logs: [],
    history: [],
    signals: {
      failedStepType: 'ui',
      failedStepKeyword: 'When',
      failedStepText: 'I click old-submit',
      endpoints: [],
      selectors: ['button[data-testid=old-submit]'],
      selectorChanged: true,
      testFilesChanged: false,
      productFilesChanged: true,
      codeTouchConfidence: 0.7,
    },
    diff: {
      available: true,
      files: [
        {
          path: 'src/pages/posts.tsx',
          status: 'modified',
          category: 'frontend',
          hunks: [],
        },
      ],
      testFilesChanged: false,
      truncated: false,
    },
    codeLocations: [
      {
        path: 'src/pages/posts.tsx',
        line: 10,
        reason: 'selector rename',
        confidence: 0.7,
      },
    ],
    rerun: null,
    redacted: true,
  };
}

function fakeLlm(patchedContent: string): LlmClient {
  return {
    async generate() {
      return {
        text: JSON.stringify({
          patched_content: patchedContent,
          rationale: 'update renamed selector',
          repair_class: 'selector_rename',
          evidence_refs: ['step:1', 'diff:src/pages/posts.tsx:10'],
        }),
        usage: { inputTokens: 10, outputTokens: 20, model: 'fake' },
      };
    },
  };
}

describe('repair proposal', () => {
  it('produces an allowed safe selector patch when evidence is valid', async () => {
    const patched = original.replace('old-submit', 'new-submit');
    const result = await proposeTestRepair({
      client: fakeLlm(patched),
      pack: pack(),
      attribution,
      originalContent: original,
      priorAttempts: 0,
    });

    expect(result.proposal?.patch?.patchedContent).toContain('new-submit');
    expect(result.proposal?.guard.status).toBe('allowed');
    expect(result.usage?.model).toBe('fake');
  });

  it('requires human approval when a Then expectation changes', async () => {
    const patched = original.replace('"ok"', '"success"');
    const result = await proposeTestRepair({
      client: fakeLlm(patched),
      pack: pack(),
      attribution,
      originalContent: original,
      priorAttempts: 0,
    });

    expect(result.proposal?.guard.status).toBe('human_required');
  });

  it('keeps suggestions human-only when no LLM is configured', async () => {
    const result = await proposeTestRepair({
      client: null,
      pack: pack(),
      attribution,
      originalContent: original,
      priorAttempts: 0,
    });

    expect(result.proposal?.patch).toBeNull();
    expect(result.proposal?.guard.status).toBe('human_required');
  });

  it('does not propose patches for code bugs or low confidence', async () => {
    const result = await proposeTestRepair({
      client: fakeLlm(original),
      pack: pack(),
      attribution: { ...attribution, verdict: 'code_bug', testRepairAllowed: false },
      originalContent: original,
      priorAttempts: 0,
    });

    expect(result.proposal?.patch).toBeNull();
    expect(result.usage).toBeNull();
  });

  it('renders a simple line diff for approval UI', () => {
    const diff = simplePatchDiff('a\nb\n', 'a\nc\n', 'features/x.feature');

    expect(diff).toContain('--- a/features/x.feature');
    expect(diff).toContain('-b');
    expect(diff).toContain('+c');
  });
});
