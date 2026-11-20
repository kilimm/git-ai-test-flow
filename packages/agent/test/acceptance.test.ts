// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffCollection, DiffFile } from '@gait/shared';
import {
  FeatureIndexRepository,
  GenerationFileRepository,
  GenerationRepository,
  ProjectRepository,
  TenantRepository,
} from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import { StepRegistry } from '@gait/runner';
import { SuiteRepository } from '@gait/git';
import type { LlmClient } from '../src/llm/llm-client.js';
import {
  buildGenerationCommitMessage,
  commitGeneration,
  retrieveCasesForFeaturePoints,
  runGenerationWorkflow,
} from '../src/index.js';

function scenarios(prefix: string, count: number): string {
  const lines: string[] = [];

  for (let index = 1; index <= count; index += 1) {
    lines.push(
      `  @case:${prefix}-${String(index).padStart(3, '0')} @generated`,
      `  Scenario: 场景 ${index}`,
      '    When I send a GET request to "/api/posts"',
      '    Then the response status should be 200',
      '',
    );
  }

  return lines.join('\n');
}

const DESIGN_FILES = [
  {
    path: 'features/posts/read.feature',
    content: [
      '@module:posts @layer:api @risk:high @generated',
      'Feature: 帖子读取',
      '',
      scenarios('POST-READ', 5),
    ].join('\n'),
  },
  {
    path: 'features/posts/errors.feature',
    content: [
      '@module:posts @layer:api @risk:medium @generated',
      'Feature: 帖子错误处理',
      '',
      scenarios('POST-ERROR', 5),
    ].join('\n'),
  },
];

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
    sizeBytes: 30,
    additions: 1,
    deletions: 0,
    patch: '+handler',
    hunks: [
      {
        header: '@@ -1 +1 @@',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        content: '+handler',
      },
    ],
  };
}

function collection(): DiffCollection {
  const files = [
    file('src/api/posts-read.ts'),
    file('src/api/posts-create.ts'),
    file('src/api/posts-delete.ts'),
  ];

  return {
    mode: 'range',
    baseSha: 'a'.repeat(40),
    headSha: 'c'.repeat(40),
    branch: 'main',
    commits: [1, 2, 3].map((index) => ({
      sha: String(index).repeat(40),
      shortSha: String(index).repeat(8),
      author: 'dev',
      email: 'dev@example.com',
      committedAt: 1_700_000_000_000 + index,
      title: `feat: commit ${index}`,
    })),
    files,
    stats: {
      totalFiles: 3,
      includedFiles: 3,
      skippedFiles: 0,
      truncatedFiles: 0,
      sensitiveFiles: 0,
      totalBytes: 90,
      includedBytes: 90,
      skippedByReason: {},
    },
    truncated: false,
  };
}

function fakeLlm(): LlmClient {
  return {
    async generate(request) {
      const usage = { inputTokens: 2, outputTokens: 2, model: 'fake-model' };

      if (request.system.includes('测试分析师')) {
        return {
          text: JSON.stringify({
            summaries: [
              {
                path: 'src/api/posts-read.ts',
                intent: '读取接口',
                behaviorChanges: ['GET'],
                modules: ['posts'],
                risk: 'high',
              },
              {
                path: 'src/api/posts-create.ts',
                intent: '创建接口',
                behaviorChanges: ['POST'],
                modules: ['posts'],
                risk: 'high',
              },
              {
                path: 'src/api/posts-delete.ts',
                intent: '删除接口',
                behaviorChanges: ['DELETE'],
                modules: ['posts'],
                risk: 'medium',
              },
            ],
          }),
          usage,
        };
      }

      if (request.system.includes('测试架构师')) {
        return {
          text: JSON.stringify({
            features: [
              {
                title: '帖子读取',
                description: 'GET /api/posts',
                kind: 'api',
                risk: 'high',
                affectedModules: ['posts'],
                sources: [{ path: 'src/api/posts-read.ts', hunk: '', reason: 'read' }],
                docRefs: [],
                suggestedLayer: ['api'],
              },
              {
                title: '帖子创建',
                description: 'POST /api/posts',
                kind: 'api',
                risk: 'high',
                affectedModules: ['posts'],
                sources: [{ path: 'src/api/posts-create.ts', hunk: '', reason: 'create' }],
                docRefs: [],
                suggestedLayer: ['api'],
              },
            ],
          }),
          usage,
        };
      }

      if (request.system.includes('Gherkin')) {
        return { text: JSON.stringify({ files: DESIGN_FILES }), usage };
      }

      return {
        text: JSON.stringify({ acceptable: true, summary: 'ok', issues: [] }),
        usage,
      };
    },
  };
}

describe('M4 exit acceptance', () => {
  it('turns three commits into ten validated scenarios and commits them to the suite', async () => {
    const database = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), 'gait-m4-acceptance-'));

    try {
      const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
      const project = new ProjectRepository(database.db, tenant.id).create({
        name: 'Demo',
        slug: 'demo',
        productRepoUrl: 'https://github.com/acme/demo.git',
        defaultBranch: 'main',
        suiteMode: 'managed',
        featureRoot: 'features/',
        docsRoot: 'docs/ai/',
      });
      const suite = await SuiteRepository.open({
        mode: 'managed',
        projectId: project.id,
        projectSlug: project.slug,
        projectRepoUrl: project.productRepoUrl,
        featureRoot: project.featureRoot,
        dataDir,
      });
      const index = new FeatureIndexRepository(database.db, tenant.id);
      const generations = new GenerationRepository(database.db, tenant.id);
      const generationFiles = new GenerationFileRepository(database.db, tenant.id);
      const generation = generations.create({
        id: 'acceptance-generation',
        projectId: project.id,
        baseSha: 'a'.repeat(40),
        headSha: 'c'.repeat(40),
        branch: 'main',
        mode: 'range',
        idempotencyKey: `${project.id}:${'c'.repeat(40)}:all`,
        status: 'running',
      });

      const result = await runGenerationWorkflow(
        {
          llm: fakeLlm(),
          collectDiff: async () => collection(),
          stepRegistry: StepRegistry.createDefault(),
          retrieveExistingCases: async (featurePoints) =>
            retrieveCasesForFeaturePoints(project.id, index, featurePoints),
          featurePrefix: suite.featurePrefix,
        },
        {
          tenantId: tenant.id,
          projectId: project.id,
          generationId: generation.id,
          baseSha: generation.baseSha,
          headSha: generation.headSha,
          branch: 'main',
          mode: 'range',
          model: 'fake-model',
          promptVersion: 'm4-v1',
          selection: null,
        },
      );

      expect(result.outcome).toBe('awaiting_approval');
      expect(result.state.commits).toHaveLength(3);
      expect(result.state.validation?.valid).toBe(true);
      expect(result.state.validation?.scenarioCount).toBe(10);
      expect(
        result.state.validation?.files.every((file) => file.validationStatus === 'valid'),
      ).toBe(true);

      generationFiles.replaceForGeneration(
        generation.id,
        result.state.drafts.map((draft) => {
          const validated = result.state.validation?.files.find((file) => file.path === draft.path);

          return {
            path: draft.path,
            action: draft.action,
            content: draft.content,
            contentHash: validated?.contentHash ?? '',
            scenarioCount: validated?.scenarioCount ?? 0,
            validationStatus: 'valid',
            validationErrors: [],
          };
        }),
      );

      const commit = await commitGeneration({
        suite,
        featureIndex: index,
        generationRepository: generations,
        generationFileRepository: generationFiles,
        generationId: generation.id,
        projectId: project.id,
        files: result.state.drafts,
        message: buildGenerationCommitMessage({
          generationId: generation.id,
          headSha: generation.headSha,
          featurePointIds: result.state.featurePoints.map((item) => item.id),
        }),
        now: 1_700_000_000_000,
      });

      expect(commit.changed).toBe(true);
      expect(commit.index).toMatchObject({ files: 2, scenarios: 10, missing: 0 });
      expect(index.listActiveCases(project.id)).toHaveLength(10);

      // 相同内容再次提交是幂等的，不产生重复用例。
      const repeated = await commitGeneration({
        suite,
        featureIndex: index,
        generationRepository: generations,
        generationFileRepository: generationFiles,
        generationId: generation.id,
        projectId: project.id,
        files: result.state.drafts,
        message: 'duplicate',
        now: 1_700_000_100_000,
      });
      expect(repeated.changed).toBe(false);
      expect(index.listActiveCases(project.id)).toHaveLength(10);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      database.cleanup();
    }
  }, 30_000);
});
