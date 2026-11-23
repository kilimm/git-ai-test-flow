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
import {
  clearModuleScanState,
  createModuleScanJobHandler,
  readLatestModuleScan,
} from '../src/module-scan-handler.js';

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

function write(directory: string, path: string, content: string): void {
  const absolute = join(directory, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

async function createProductRemote(root: string): Promise<{ remote: string; sha: string }> {
  const seed = join(root, 'product-seed');
  mkdirSync(seed, { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: seed });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: seed });
  write(seed, 'src/modules/posts/comments/service.ts', 'export const comments = () => [];\n');
  write(seed, 'src/modules/posts/post-service.ts', 'export const posts = () => [];\n');
  write(seed, 'src/modules/auth/login.ts', 'export const login = () => null;\n');
  write(seed, 'src/api/index.ts', 'export const api = true;\n');
  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'feat: initial'], { cwd: seed });
  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
  const remote = join(root, 'product.git');
  await runGit(['clone', '--bare', seed, remote]);

  return { remote, sha };
}

function fakeLlm(): LlmClient {
  const usage = { inputTokens: 1, outputTokens: 1, model: 'fake-model' };
  let designPath = 'features/posts/create.feature';

  return {
    async generate(request) {
      if (request.system.includes('测试分析师')) {
        return {
          text: JSON.stringify({ summaries: [] }),
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
                sources: [],
                docRefs: [],
                suggestedLayer: ['api'],
              },
            ],
          }),
          usage,
        };
      }

      if (request.system.includes('Gherkin')) {
        designPath = request.user.includes('posts.comments')
          ? 'features/posts/comments.feature'
          : designPath;

        return {
          text: JSON.stringify({
            files: [
              {
                path: designPath,
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

function jobFor(tenantId: string, id: string, payload: Record<string, string> = {}): Job {
  return {
    id: `job-${id}`,
    tenantId,
    type: 'generation.run',
    payloadJson: JSON.stringify({ generationId: id, ...payload }),
    status: 'running',
    priority: 10,
    runAfter: 0,
    attempts: 1,
    maxAttempts: 2,
    lockedBy: 'worker-1',
    leaseExpiresAt: Date.now() + 60_000,
    dedupeKey: `job:${id}`,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function setup(root: string): Promise<{
  dataDir: string;
  env: ReturnType<typeof loadEnv>;
  database: Awaited<ReturnType<typeof createTestDatabase>>;
  tenantId: string;
  projectId: string;
}> {
  const dataDir = join(root, 'data');
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEY,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATA_DIR: dataDir,
  });
  const { remote } = await createProductRemote(root);
  const database = await createTestDatabase();
  const tenant = await new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const projectRepo = new ProjectRepository(database.db, tenant.id);
  const project = await projectRepo.create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: remote,
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });
  const cipher = new SecretCipher(createEncryptionKey(ENCRYPTION_KEY, 1));
  const credential = await new CredentialRepository(database.db, tenant.id).create({
    id: 'llm-credential',
    name: 'LLM Key',
    type: 'llm_api_key',
    secret: cipher.encrypt(tenant.id, 'llm-credential', 'llm_api_key', 'sk-test-key'),
  });
  // 同一租户下两个项目共用同一个 LLM profile 会导致扫描旧 profile；按项目建。
  await new LlmProfileRepository(database.db, tenant.id).create({
    projectId: project.id,
    name: 'Generation',
    purpose: 'generation',
    provider: 'openai-compatible',
    baseUrl: 'https://llm.example.com/v1',
    model: 'fake-model',
    credentialId: credential.id,
  });

  return { dataDir, env, database, tenantId: tenant.id, projectId: project.id };
}

describe('generation worker handler', () => {
  it('runs a baseline generation over the full repository snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-worker-baseline-'));
    const { env, database, tenantId, projectId } = await setup(root);

    try {
      const generations = new GenerationRepository(database.db, tenantId);
      const generation = await generations.create({
        id: 'generation-baseline',
        projectId,
        baseSha: null,
        headSha: 'HEAD',
        branch: 'main',
        mode: 'baseline',
        idempotencyKey: 'baseline-test',
        status: 'queued',
        statsJson: JSON.stringify({ mode: 'baseline', granularity: 'high' }),
      });
      const handler = createGenerationJobHandler({
        db: database.db,
        env,
        llmClientFactory: () => fakeLlm(),
        now: () => 1_700_000_000_000,
      });

      await handler({
        job: jobFor(tenantId, generation.id),
        payload: { generationId: generation.id },
        workerId: 'worker-1',
        signal: new AbortController().signal,
      });

      const stored = await generations.findById(generation.id);
      expect(stored).toMatchObject({ status: 'awaiting_approval' });
      // baseline 应写入空树作为 baseSha，head 为解析后的 commit。
      expect(stored?.baseSha).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
      expect(stored?.headSha).toMatch(/^[0-9a-f]{40}$/);
      const stats = JSON.parse(stored?.statsJson ?? '{}') as {
        mode: string;
        granularity: string;
        filesIncluded: number;
        modules?: { key: string; featurePoints: number }[];
      };
      expect(stats).toMatchObject({ mode: 'baseline', granularity: 'high' });
      // 全量快照包含 4 个文件（src/api/index.ts 归类为 general）。
      expect(stats.filesIncluded).toBe(4);
      // 模块树来自「功能点」，不是所有文件：fake LLM 只产出 posts 功能点。
      expect(stats.modules?.map((node) => node.key)).toEqual(['posts']);
      expect(stats.modules?.[0]?.featurePoints).toBe(1);
    } finally {
      await database.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('module scan worker handler', () => {
  it('scans the repository snapshot and builds a hierarchical module tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gait-worker-modules-'));
    const { env, database, tenantId, projectId } = await setup(root);

    try {
      clearModuleScanState();
      const handler = createModuleScanJobHandler({
        db: database.db,
        env,
        now: () => 1_700_000_000_000,
      });
      await handler({
        job: jobFor(tenantId, 'module-scan'),
        payload: { projectId },
        workerId: 'worker-1',
        signal: new AbortController().signal,
      });

      const latest = readLatestModuleScan(tenantId, projectId);
      expect(latest?.scannedFiles).toBe(4);
      expect(latest?.truncated).toBe(false);
      const posts = latest?.modules.find((node) => node.key === 'posts');

      expect(posts?.children.map((child) => child.key)).toEqual(['posts.comments']);
      expect(posts?.featurePoints).toBe(2);
      expect(latest?.modules.map((node) => node.key)).toEqual(['auth', 'general', 'posts']);

      // 第二次调用命中缓存。
      await handler({
        job: jobFor(tenantId, 'module-scan-2'),
        payload: { projectId },
        workerId: 'worker-1',
        signal: new AbortController().signal,
      });
      expect(readLatestModuleScan(tenantId, projectId)?.cached).toBe(true);
    } finally {
      clearModuleScanState();
      await database.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
