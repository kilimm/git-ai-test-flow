// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { AttributionResult, EvidencePack } from '@gait/shared';
import type { LlmClient } from '../src/llm/llm-client.js';
import {
  attributeWithLlm,
  combineAttributions,
  buildAttributionPrompt,
} from '../src/attribution/llm-attribution.js';

const PACK: EvidencePack = {
  version: 1,
  collectedAt: 1,
  run: {
    id: 'run-1',
    projectId: 'project-1',
    branch: 'main',
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    deployedSha: 'a'.repeat(40),
    versionMatch: true,
    status: 'running',
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
    featurePath: 'features/api/posts.feature',
    scenarioName: 'create post',
    line: 3,
    caseKey: 'POST-001',
    tags: ['layer:api'],
    layer: 'api',
    status: 'failed',
    attempt: 1,
    errorMessage: 'expected 400 but received 500',
    featureSource: 'Feature: posts',
  },
  failedStepIndex: 1,
  steps: [
    {
      index: 1,
      keyword: 'Then',
      text: 'the response status should be 400',
      type: 'api',
      status: 'failed',
      durationMs: 10,
      error: { code: 'EXPECTED_STATUS', message: 'expected 400 but received 500' },
      output: {},
    },
  ],
  artifacts: [],
  logs: [],
  history: [],
  signals: {
    failedStepType: 'api',
    failedStepKeyword: 'Then',
    failedStepText: 'the response status should be 400',
    endpoints: ['/api/posts'],
    selectors: [],
    selectorChanged: false,
    testFilesChanged: false,
    productFilesChanged: true,
    codeTouchConfidence: 0.55,
  },
  diff: { available: true, files: [], testFilesChanged: false, truncated: false },
  codeLocations: [],
  rerun: null,
  redacted: true,
};

function rule(overrides: Partial<AttributionResult> = {}): AttributionResult {
  return {
    verdict: 'unknown',
    confidence: 0.35,
    rootCause: '证据不足',
    evidenceRefs: ['step:1'],
    suggestedFix: null,
    testRepairAllowed: false,
    source: 'rule',
    conflict: null,
    ...overrides,
  };
}

function fakeClient(outputs: readonly unknown[]): LlmClient {
  let call = 0;

  return {
    async generate() {
      const output = outputs[Math.min(call, outputs.length - 1)];
      call += 1;

      if (output instanceof Error) {
        throw output;
      }

      return {
        text: typeof output === 'string' ? output : JSON.stringify(output),
        usage: { inputTokens: 100, outputTokens: 20, model: 'fake-model' },
      };
    },
  };
}

const VALID_OUTPUT = {
  verdict: 'test_bug',
  confidence: 0.86,
  root_cause: '接口路径已变更为 /api/v2/posts',
  evidence_refs: ['step:1'],
  suggested_fix: '更新 feature 中的接口路径',
  test_repair_allowed: true,
};

describe('LLM 归因', () => {
  it('接受带有效证据引用的结构化输出', async () => {
    const result = await attributeWithLlm({
      client: fakeClient([VALID_OUTPUT]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1', 'environment'],
    });

    expect(result).not.toBeNull();
    expect(result?.attribution.verdict).toBe('test_bug');
    expect(result?.attribution.confidence).toBe(0.86);
    expect(result?.attribution.testRepairAllowed).toBe(true);
    expect(result?.attribution.source).toBe('llm');
    expect(result?.usage.inputTokens).toBe(100);
  });

  it('没有有效证据引用时回退 unknown', async () => {
    const result = await attributeWithLlm({
      client: fakeClient([{ ...VALID_OUTPUT, evidence_refs: ['step:99'] }]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result?.attribution.verdict).toBe('unknown');
    expect(result?.attribution.evidenceRefs).toEqual([]);
  });

  it('低置信度输出降级为 unknown', async () => {
    const result = await attributeWithLlm({
      client: fakeClient([{ ...VALID_OUTPUT, confidence: 0.3 }]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result?.attribution.verdict).toBe('unknown');
    expect(result?.attribution.rootCause).toContain('置信度不足');
  });

  it('code_bug 强制禁止修改测试', async () => {
    const result = await attributeWithLlm({
      client: fakeClient([{ ...VALID_OUTPUT, verdict: 'code_bug', test_repair_allowed: true }]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result?.attribution.verdict).toBe('code_bug');
    expect(result?.attribution.testRepairAllowed).toBe(false);
  });

  it('输出非法 JSON 时重试一次后失败返回 null', async () => {
    const result = await attributeWithLlm({
      client: fakeClient(['not json', 'still not json']),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result).toBeNull();
  });

  it('第一次 JSON 非法时重试成功', async () => {
    const result = await attributeWithLlm({
      client: fakeClient(['not json', VALID_OUTPUT]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result?.attribution.verdict).toBe('test_bug');
  });

  it('供应商异常时返回 null，由规则兜底', async () => {
    const result = await attributeWithLlm({
      client: fakeClient([new Error('network down')]),
      pack: PACK,
      rule: rule(),
      allowedRefs: ['step:1'],
    });

    expect(result).toBeNull();
  });

  it('强规则结论不被 LLM 覆盖，并记录冲突', () => {
    const combined = combineAttributions(
      rule({ verdict: 'env_issue', confidence: 0.95, source: 'rule' }),
      {
        verdict: 'code_bug',
        confidence: 0.9,
        rootCause: 'LLM says code bug',
        evidenceRefs: ['step:1'],
        suggestedFix: null,
        testRepairAllowed: false,
        source: 'llm',
        conflict: null,
      },
    );

    expect(combined.verdict).toBe('env_issue');
    expect(combined.conflict?.otherVerdict).toBe('code_bug');
  });

  it('规则为 unknown 时采用高置信 LLM 结论', () => {
    const combined = combineAttributions(rule(), {
      verdict: 'code_bug',
      confidence: 0.8,
      rootCause: '接口返回 500',
      evidenceRefs: ['step:1'],
      suggestedFix: null,
      testRepairAllowed: false,
      source: 'llm',
      conflict: null,
    });

    expect(combined.verdict).toBe('code_bug');
    expect(combined.source).toBe('llm');
  });

  it('prompt 包含证据引用白名单与规则初判', () => {
    const prompt = buildAttributionPrompt(PACK, rule(), ['step:1', 'environment']);

    expect(prompt).toContain('allowed_evidence_refs');
    expect(prompt).toContain('step:1');
    expect(prompt).toContain('规则引擎初判');
    expect(prompt).toContain('features/api/posts.feature');
  });
});
