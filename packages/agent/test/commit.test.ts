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

const FEATURE = [
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
].join('\n');

function fakeLlm(): LlmClient {
  return {
    async generate(request) {
      const usage = { inputTokens: 1, outputTokens: 1, model: 'fake-model' };

      if (request.system.includes('测试分析师')) {
        return {
          text: JSON.stringify({
            summaries: [
              {
                path: 'src/api/posts.ts',
                intent: '新增创建帖子接口',
                behaviorChanges: ['POST /api/posts'],
                modules: ['posts'],
                risk: 'high',
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
                title: '创建帖子 API',
                description: 'POST /api/posts',
                kind: 'api',
                risk: 'high',
                affectedModules: ['posts'],
                sources: [{ path: 'src/api/posts.ts', hunk: '@@ -1 +1 @@', reason: 'endpoint' }],
                docRefs: [],
                suggestedLayer: ['api'],
              },
            ],
          }),
          usage,
        };
      }

      if (request.system.includes('Gherkin')) {
        return {
          text: JSON.stringify({
            files: [{ path: 'features/posts/create.feature', content: FEATURE }],
          }),
          usage,
        };
      }

      return {
        text: JSON.stringify({ acceptable: true, summary: 'ok', issues: [] }),
        usage,
      };
    },
  };
}

function diff(): DiffCollection {
  const file: DiffFile = {
    path: 'src/api/posts.ts',
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
    sizeBytes: 50,
    additions: 1,
    deletions: 0,
    patch: '+export const create = true;',
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
        committedAt: 1_700_000_000_000,
        title: 'feat: posts',
      },
    ],
    files: [file],
    stats: {
      totalFiles: 1,
      includedFiles: 1,
      skippedFiles: 0,
      truncatedFiles: 0,
      sensitiveFiles: 0,
      totalBytes: 50,
      includedBytes: 50,
      skippedByReason: {},
    },
    truncated: false,
  };
}

describe('generation commit pipeline', () => {
  it('persists drafts, commits to the suite, reindexes and stays idempotent', async () => {
    const database = await createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), 'gait-m4-commit-'));

    try {
      const tenant = await new TenantRepository(database.db).create({
        slug: 'acme',
        name: 'Acme',
      });
      const project = await new ProjectRepository(database.db, tenant.id).create({
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
      const generation = await generations.create({
        id: 'generation-1',
        projectId: project.id,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        branch: 'main',
        mode: 'range',
        idempotencyKey: `${project.id}:${'b'.repeat(40)}:all`,
        status: 'running',
      });

      const result = await runGenerationWorkflow(
        {
          llm: fakeLlm(),
          collectDiff: async () => diff(),
          stepRegistry: StepRegistry.createDefault(),
          retrieveExistingCases: async (featurePoints) =>
            await retrieveCasesForFeaturePoints(project.id, index, featurePoints),
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
      expect(result.state.validation?.valid).toBe(true);

      await generations.update(generation.id, {
        status: 'awaiting_approval',
        featurePointsJson: JSON.stringify(result.state.featurePoints),
        statsJson: JSON.stringify(result.stats),
      });
      await generationFiles.replaceForGeneration(
        generation.id,
        result.state.drafts.map((draft) => {
          const validated = result.state.validation?.files.find((file) => file.path === draft.path);

          return {
            path: draft.path,
            action: draft.action,
            content: draft.content,
            contentHash: validated?.contentHash ?? 'missing',
            scenarioCount: validated?.scenarioCount ?? 0,
            validationStatus: validated?.validationStatus ?? 'invalid',
            validationErrors: validated?.issues ?? [],
          };
        }),
      );

      const message = buildGenerationCommitMessage({
        generationId: generation.id,
        headSha: generation.headSha,
        featurePointIds: result.state.featurePoints.map((featurePoint) => featurePoint.id),
      });
      const commit = await commitGeneration({
        suite,
        featureIndex: index,
        generationRepository: generations,
        generationFileRepository: generationFiles,
        generationId: generation.id,
        projectId: project.id,
        files: result.state.drafts.map((draft) => ({
          path: draft.path,
          content: draft.content,
        })),
        message,
        now: 1_700_000_000_000,
      });

      expect(commit.changed).toBe(true);
      expect(commit.index).toMatchObject({ files: 1, scenarios: 1, missing: 0 });
      expect(await index.listActiveCases(project.id)).toHaveLength(1);
      expect(await generations.findById(generation.id)).toMatchObject({
        status: 'committed',
        approvalStatus: 'approved',
      });
      expect(
        (await generationFiles.listByGeneration(generation.id)).every(
          (file) => file.committedSha !== null,
        ),
      ).toBe(true);
      expect(await suite.listFeatureFiles()).toHaveLength(1);

      const repeated = await commitGeneration({
        suite,
        featureIndex: index,
        generationRepository: generations,
        generationFileRepository: generationFiles,
        generationId: generation.id,
        projectId: project.id,
        files: result.state.drafts.map((draft) => ({
          path: draft.path,
          content: draft.content,
        })),
        message,
        now: 1_700_000_100_000,
      });
      expect(repeated.changed).toBe(false);
      expect(repeated.commitSha).toBe(commit.commitSha);
      expect(await index.listActiveCases(project.id)).toHaveLength(1);

      const existing = await retrieveCasesForFeaturePoints(
        project.id,
        index,
        result.state.featurePoints,
      );
      expect(existing).toHaveLength(1);
      expect(existing[0]?.caseKey).toBe('POST-GEN-001');
      expect(['covered', 'needs_update']).toContain(existing[0]?.coverage);

      const log = await import('@gait/git').then((git) =>
        git.runGit(['log', '-1', '--format=%B'], { cwd: suite.root }),
      );
      expect(log.stdout).toContain(`generation-id: ${generation.id}`);
      expect(log.stdout).toContain(`source-commit: ${generation.headSha}`);
    } finally {
      await rmSync(dataDir, { recursive: true, force: true });
      await database.cleanup();
    }
  });
});
