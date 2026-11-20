// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { DiffCollection, DiffFile } from '@gait/shared';
import { StepRegistry } from '@gait/runner';
import type { LlmClient, LlmRequest } from '../src/llm/llm-client.js';
import { runGenerationWorkflow } from '../src/generation/workflow.js';
import type { GenerationWorkflowDeps, GenerationWorkflowInput } from '../src/generation/types.js';

const FEATURE_POINT = {
  id: 'FP-001',
  title: '创建帖子 API',
  description: 'POST /api/posts 支持 title 并返回 201',
  kind: 'api',
  risk: 'high',
  affectedModules: ['posts'],
  sources: [{ path: 'src/api/posts.ts', hunk: '@@ -1 +1 @@', reason: 'new endpoint' }],
  docRefs: [],
  suggestedLayer: ['api'],
};

const VALID_FEATURE = [
  '@module:posts @layer:api @risk:high @generated',
  'Feature: Posts API',
  '',
  '  @case:POST-GEN-001 @generated',
  '  Scenario: 创建帖子返回 201',
  '    When I send a POST request to "/api/posts" with JSON:',
  '      """json',
  '      {"title": "{{fixture.post.title}}"}',
  '      """',
  '    Then the response status should be 201',
  '    And the response body at "$.title" should be "hello"',
].join('\n');

const INVALID_FEATURE = [
  '@module:posts @layer:api',
  'Feature: Broken',
  '  @case:POST-GEN-001',
  '  Scenario: Unknown step',
  '    Given an invented step that does not exist',
].join('\n');

function file(path: string): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    category: 'api',
    binary: false,
    isDoc: false,
    isTest: false,
    isOpenApi: false,
    isSensitive: false,
    skipped: false,
    skipReason: null,
    truncated: false,
    sizeBytes: 100,
    additions: 5,
    deletions: 1,
    patch: 'diff --git a/src/api/posts.ts b/src/api/posts.ts\n+export const create = true;\n',
    hunks: [
      {
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        content: '+export const create = true;',
      },
    ],
  };
}

function diffCollection(files: DiffFile[]): DiffCollection {
  return {
    mode: 'range',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'main',
    commits: [
      {
        sha: 'b'.repeat(40),
        shortSha: 'bbbbbbbb',
        author: 'dev',
        email: 'dev@example.com',
        committedAt: Date.now(),
        title: 'feat: posts',
      },
    ],
    files,
    stats: {
      totalFiles: files.length,
      includedFiles: files.filter((entry) => !entry.skipped).length,
      skippedFiles: files.filter((entry) => entry.skipped).length,
      truncatedFiles: 0,
      sensitiveFiles: 0,
      totalBytes: 100,
      includedBytes: 100,
      skippedByReason: {},
    },
    truncated: false,
  };
}

function workflowInput(): GenerationWorkflowInput {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    generationId: 'generation-1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'main',
    mode: 'range',
    model: 'fake-model',
    promptVersion: 'm4-v1',
    selection: null,
  };
}

interface FakeLlmPlan {
  summaries?: unknown;
  features?: unknown;
  designs?: string[];
  critiques?: {
    acceptable: boolean;
    summary: string;
    issues: { severity: 'error' | 'warning'; message: string }[];
  }[];
  calls?: LlmRequest[];
}

function createFakeLlm(plan: FakeLlmPlan = {}): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  let designIndex = 0;
  let critiqueIndex = 0;

  return {
    calls,
    async generate(request) {
      calls.push(request);

      const usage = { inputTokens: 10, outputTokens: 5, model: 'fake-model' };

      if (request.system.includes('测试分析师')) {
        return {
          text: JSON.stringify(
            plan.summaries ?? {
              summaries: [
                {
                  path: 'src/api/posts.ts',
                  intent: '新增创建帖子接口',
                  behaviorChanges: ['新增 POST /api/posts'],
                  modules: ['posts'],
                  risk: 'high',
                },
              ],
            },
          ),
          usage,
        };
      }

      if (request.system.includes('测试架构师')) {
        return {
          text: JSON.stringify(plan.features ?? { features: [FEATURE_POINT] }),
          usage,
        };
      }

      if (request.system.includes('Gherkin')) {
        const designs = plan.designs ?? [VALID_FEATURE];
        const content = designs[Math.min(designIndex, designs.length - 1)] ?? INVALID_FEATURE;
        designIndex += 1;

        return {
          text: JSON.stringify({
            files: [{ path: 'features/posts/create.feature', content }],
            stepProposals: [],
          }),
          usage,
        };
      }

      if (request.system.includes('评审员')) {
        const critiques = plan.critiques ?? [{ acceptable: true, summary: 'ok', issues: [] }];
        const critique = critiques[Math.min(critiqueIndex, critiques.length - 1)] ?? {
          acceptable: true,
          summary: 'ok',
          issues: [],
        };
        critiqueIndex += 1;

        return { text: JSON.stringify(critique), usage };
      }

      throw new Error(`Unexpected prompt: ${request.system}`);
    },
  };
}

function deps(overrides: Partial<GenerationWorkflowDeps> = {}): GenerationWorkflowDeps {
  return {
    llm: createFakeLlm(),
    collectDiff: async () => diffCollection([file('src/api/posts.ts')]),
    stepRegistry: StepRegistry.createDefault(),
    retrieveExistingCases: async () => [],
    featurePrefix: 'features',
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('Graph A workflow', () => {
  it('generates validated drafts and stops at approval', async () => {
    const fake = createFakeLlm();
    const result = await runGenerationWorkflow(deps({ llm: fake }), workflowInput());

    expect(result.outcome).toBe('awaiting_approval');
    expect(result.state.validation?.valid).toBe(true);
    expect(result.state.validation?.scenarioCount).toBe(1);
    expect(result.state.drafts[0]).toMatchObject({
      path: 'features/posts/create.feature',
      action: 'create',
    });
    expect(result.stats).toMatchObject({
      featurePoints: 1,
      scenarios: 1,
      retries: 0,
      tokenUsage: { inputTokens: 40, outputTokens: 20, model: 'fake-model' },
    });
    expect(fake.calls.map((call) => call.system.slice(0, 8))).toHaveLength(4);
  });

  it('rewrites invalid drafts up to two times and passes feedback to design', async () => {
    const fake = createFakeLlm({ designs: [INVALID_FEATURE, VALID_FEATURE] });
    const result = await runGenerationWorkflow(deps({ llm: fake }), workflowInput());

    expect(result.outcome).toBe('awaiting_approval');
    expect(result.state.attempts).toBe(2);
    expect(result.state.validation?.valid).toBe(true);
    expect(fake.calls.filter((call) => call.system.includes('Gherkin'))).toHaveLength(2);
    const designCalls = fake.calls.filter((call) => call.system.includes('Gherkin'));
    expect(designCalls[1]?.user).toContain('UNKNOWN_STEP');
    expect(designCalls[1]?.user).toContain('THEN_MISSING');
  });

  it('rewrites after critique rejection and fails after exhausting retries', async () => {
    const rejected = {
      acceptable: false,
      summary: 'too shallow',
      issues: [{ severity: 'error' as const, message: '缺少错误路径' }],
    };
    const retrying = createFakeLlm({
      designs: [VALID_FEATURE, VALID_FEATURE],
      critiques: [rejected, { acceptable: true, summary: 'ok', issues: [] }],
    });
    const retried = await runGenerationWorkflow(deps({ llm: retrying }), workflowInput());

    expect(retried.outcome).toBe('awaiting_approval');
    expect(retried.state.attempts).toBe(2);
    expect(retried.state.critique?.acceptable).toBe(true);

    const exhausted = createFakeLlm({
      designs: [INVALID_FEATURE],
      critiques: [rejected],
    });
    const failed = await runGenerationWorkflow(deps({ llm: exhausted }), workflowInput());

    expect(failed.outcome).toBe('failed');
    expect(failed.state.attempts).toBe(3);
    expect(failed.state.failureReason).toBe('Generated drafts failed validation');
    expect(exhausted.calls.filter((call) => call.system.includes('Gherkin')).length).toBe(3);
  });

  it('returns no_op when there are no relevant changes', async () => {
    const fake = createFakeLlm();
    const result = await runGenerationWorkflow(
      deps({
        llm: fake,
        collectDiff: async () => diffCollection([{ ...file('pnpm-lock.yaml'), skipped: true }]),
      }),
      workflowInput(),
    );

    expect(result.outcome).toBe('no_op');
    expect(result.state.validation).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(result.stats.scenarios).toBe(0);
  });

  it('returns no_op when no feature points survive normalization', async () => {
    const fake = createFakeLlm({ features: { features: [] } });
    const result = await runGenerationWorkflow(deps({ llm: fake }), workflowInput());

    expect(result.outcome).toBe('no_op');
    expect(result.state.featurePoints).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it('includes existing cases and classifies coverage when retrieving', async () => {
    const existing = {
      id: 'case-1',
      caseKey: 'POST-001',
      name: '创建帖子 API',
      featurePath: 'features/posts/existing.feature',
      moduleKey: 'posts',
      tags: ['source:src/api/posts.ts'],
      fingerprint: 'f'.repeat(64),
      status: 'active' as const,
      coverage: 'needs_update' as const,
    };
    const result = await runGenerationWorkflow(
      deps({ retrieveExistingCases: async () => [existing] }),
      workflowInput(),
    );

    expect(result.state.existingCases).toHaveLength(1);
    expect(result.stats.needsUpdate).toBe(1);
  });
});
