// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { DocRepository, JobQueue, ProjectRepository } from '@gait/db';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedTenant,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';

const contexts: TestAppContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await closeTestApp(context);
  }
});

async function setup(): Promise<{
  context: TestAppContext;
  tenantId: string;
  projectId: string;
  moduleId: string;
  versionIds: string[];
}> {
  const context = await createTestApp();
  contexts.push(context);
  const tenant = seedTenant(context.database.db);
  await seedUser(context.database.db, {
    username: 'owner',
    tenantId: tenant.id,
    role: 'owner',
  });
  const project = new ProjectRepository(context.database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://example.com/demo.git',
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });
  const repository = new DocRepository(context.database.db, tenant.id);
  const now = Date.now();
  const module = repository.upsertModule({
    projectId: project.id,
    key: 'posts',
    name: '帖子',
    description: '帖子模块',
    pathPatterns: ['src/posts/**'],
    owner: 'content',
  });
  const first = repository.createVersion({
    projectId: project.id,
    docModuleId: module.id,
    commitSha: 'a'.repeat(40),
    contentMd: '# 帖子\n\n旧文档\n',
    contentHash: 'hash-1',
    status: 'superseded',
    now,
  });
  const second = repository.createVersion({
    projectId: project.id,
    docModuleId: module.id,
    commitSha: 'b'.repeat(40),
    contentMd: '# 帖子\n\n新文档\n',
    contentHash: 'hash-2',
    status: 'committed',
    now: now + 1_000,
  });
  repository.upsertEntry({
    projectId: project.id,
    commitSha: 'b'.repeat(40),
    committedAt: Date.now(),
    author: 'dev',
    title: 'feat: new posts',
    summaryMd: 'summary',
    detailMd: 'detail',
    files: ['src/posts/index.ts'],
    modules: ['posts'],
    tokenCount: 10,
  });

  return {
    context,
    tenantId: tenant.id,
    projectId: project.id,
    moduleId: module.id,
    versionIds: [first.id, second.id],
  };
}

describe('document API', () => {
  it('lists modules, versions and diffs; queues regenerate/compress', async () => {
    const { context, projectId, moduleId, versionIds } = await setup();
    const session = await login(context.app, 'owner', TEST_PASSWORD);

    const list = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/doc-modules`,
      session,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Array<{ key: string }> }).items[0]?.key).toBe('posts');

    const module = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/doc-modules/${moduleId}`,
      session,
    });
    const moduleBody = module.json() as {
      module: { key: string };
      version: { contentMd: string };
    };

    expect(moduleBody.module.key).toBe('posts');
    expect(moduleBody.version.contentMd).toContain('新文档');

    const versions = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/doc-modules/${moduleId}/versions`,
      session,
    });
    expect((versions.json() as { items: unknown[] }).items).toHaveLength(2);

    const diff = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/doc-modules/${moduleId}/diff?from=${versionIds[0]}&to=${versionIds[1]}`,
      session,
    });
    expect(diff.statusCode).toBe(200);
    expect((diff.json() as { diff: string }).diff).toContain('-旧文档');

    const entries = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/doc-entries`,
      session,
    });
    expect((entries.json() as { items: unknown[] }).items).toHaveLength(1);

    const regenerate = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/docs/regenerate`,
      session,
      payload: {},
    });
    expect(regenerate.statusCode).toBe(202);
    expect((regenerate.json() as { jobId: string }).jobId).toBeTruthy();

    const compress = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/docs/compress`,
      session,
      payload: {},
    });
    expect(compress.statusCode).toBe(202);
    expect(new JobQueue(context.database.db).stats().byStatus['queued']).toBe(2);
  });
});
