// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEncryptionKey, loadEnv, SecretCipher } from '@gait/config';
import {
  CredentialRepository,
  GenerationRepository,
  LlmProfileRepository,
  ProjectRepository,
  TenantRepository,
} from '@gait/db';
import type { Job } from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import { runGit } from '@gait/git';
import type { LlmClient } from '@gait/agent';
import { createGenerationJobHandler } from '../src/generation-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

function write(directory: string, path: string, content: string): void {
  const absolute = join(directory, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

async function createProductRemote(
  root: string,
): Promise<{ remote: string; base: string; head: string }> {
  const seed = join(root, 'product-seed');
  mkdirSync(seed, { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: seed });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: seed });
  write(seed, 'src/api/posts.ts', 'export const list = () => [];\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'chore: base'], { cwd: seed });
  const base = (await runGit(['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
  write(
    seed,
    'src/api/posts.ts',
    [
      'export const list = () => [];',
      'export const create = (title: string) => ({ title });',
      '',
    ].join('\n'),
  );
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'feat(api): create post'], { cwd: seed });
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
  const remote = join(root, 'product.git');
  await runGit(['clone', '--bare', seed, remote]);

  return { remote, base, head };
}

function fakeLlm(): LlmClient {
  const usage = { inputTokens: 1, outputTokens: 1, model: 'fake-model' };

  return {
    async generate(request) {
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
                sources: [{ path: 'src/api/posts.ts', hunk: '', reason: 'endpoint' }],
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
            files: [
              {
                path: 'features/posts/create.feature',
                content: [
                  '@module:posts @layer:api @generated',
                  'Feature: Posts API',
                  '  @case:POST-WORKER-001 @generated',
                  '  Scenario: create post',
                  '    When I send a POST request to "/api/posts" with JSON:',
                  '      """json',
                  '      {"title": "{{fixture.post.title}}"}',
                  '      """',
                  '    Then the response status should be 201',
                ].join('\n'),
              },
            ],
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

function jobFor(tenantId: string, generationId: string): Job {
  return {
    id: 'job-1',
    tenantId,
    type: 'generation.run',
    payloadJson: JSON.stringify({ generationId }),
    status: 'running',
    priority: 10,
    runAfter: 0,
    attempts: 1,
    maxAttempts: 2,
    lockedBy: 'worker-1',
    leaseExpiresAt: Date.now() + 60_000,
    dedupeKey: `generation:${generationId}`,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('generation worker handler', () => {
  it('runs Graph A against a real mirror and persists awaiting approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-worker-generation-'));
    const database = createTestDatabase();

    try {
      const dataDir = join(root, 'data');
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        ENCRYPTION_KEY,
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        DATA_DIR: dataDir,
      });
      const { remote, base, head } = await createProductRemote(root);
      const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
      const project = new ProjectRepository(database.db, tenant.id).create({
        name: 'Demo',
        slug: 'demo',
        productRepoUrl: remote,
        defaultBranch: 'main',
        suiteMode: 'managed',
        featureRoot: 'features/',
        docsRoot: 'docs/ai/',
      });
      const cipher = new SecretCipher(createEncryptionKey(ENCRYPTION_KEY, 1));
      const credential = new CredentialRepository(database.db, tenant.id).create({
        id: 'llm-credential',
        name: 'LLM Key',
        type: 'llm_api_key',
        secret: cipher.encrypt(tenant.id, 'llm-credential', 'llm_api_key', 'sk-test-key'),
      });
      new LlmProfileRepository(database.db, tenant.id).create({
        projectId: project.id,
        name: 'Generation',
        purpose: 'generation',
        provider: 'openai-compatible',
        baseUrl: 'https://llm.example.com/v1',
        model: 'fake-model',
        credentialId: credential.id,
      });
      const generations = new GenerationRepository(database.db, tenant.id);
      const generation = generations.create({
        id: 'generation-worker',
        projectId: project.id,
        baseSha: base,
        headSha: head,
        branch: 'main',
        mode: 'range',
        idempotencyKey: 'worker-test',
        status: 'queued',
      });
      const handler = createGenerationJobHandler({
        db: database.db,
        env,
        llmClientFactory: () => fakeLlm(),
        now: () => 1_700_000_000_000,
      });

      await handler({
        job: jobFor(tenant.id, generation.id),
        payload: { generationId: generation.id },
        workerId: 'worker-1',
        signal: new AbortController().signal,
      });

      const stored = generations.findById(generation.id);
      expect(stored).toMatchObject({
        status: 'awaiting_approval',
        approvalStatus: 'pending',
      });
      expect(JSON.parse(stored?.statsJson ?? '{}')).toMatchObject({
        commits: 1,
        scenarios: 1,
        featurePoints: 1,
      });
      const files = database.sqlite
        .prepare('SELECT path, validation_status, scenario_count FROM generation_files')
        .all();
      expect(files).toEqual([
        {
          path: 'features/posts/create.feature',
          validation_status: 'valid',
          scenario_count: 1,
        },
      ]);
      expect(
        database.sqlite
          .prepare("SELECT action FROM audit_logs WHERE action = 'generation.fail'")
          .all(),
      ).toEqual([]);
    } finally {
      database.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
