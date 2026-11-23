// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { FeatureIndexRepository, ProjectRepository, TenantRepository } from '../src/index.js';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';

function scenario(caseKey: string, name: string, line: number, module: string) {
  return {
    caseKey,
    name,
    line,
    tags: [`module:${module}`, 'layer:api', `case:${caseKey}`],
    contentHash: `hash-${caseKey}`,
    fingerprint: `fingerprint-${caseKey}`,
    searchText: `${name}\nI send a GET request to /api/posts`,
  };
}

async function setup(): Promise<{
  database: TestDatabase;
  index: FeatureIndexRepository;
  tenantId: string;
  projectId: string;
}> {
  const database = await createTestDatabase();
  const tenant = await new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = await new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://github.com/acme/demo.git',
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });

  return {
    database,
    index: new FeatureIndexRepository(database.db, tenant.id),
    tenantId: tenant.id,
    projectId: project.id,
  };
}

describe('feature index repository', () => {
  it('indexes scenarios, searches case-insensitively and marks removed cases obsolete', async () => {
    const { database, index, projectId } = await setup();

    try {
      const first = await index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/posts/create.feature',
        blobSha: 'blob-1',
        moduleKey: 'posts',
        tags: ['module:posts'],
        scenarios: [
          scenario('POST-001', 'Create post through API', 4, 'posts'),
          scenario('POST-002', 'List posts', 12, 'posts'),
        ],
      });
      expect(first).toMatchObject({ active: 2, obsolete: 0 });

      expect(
        (await index.searchCases(projectId, 'create post')).map((item) => item.caseKey),
      ).toContain('POST-001');
      expect(
        (await index.searchCases(projectId, 'List posts')).map((item) => item.caseKey),
      ).toContain('POST-002');
      expect(await index.searchCases(projectId, 'create', ['auth'])).toHaveLength(0);
      expect(await index.searchCases(projectId, 'create', ['posts'])).toHaveLength(1);
      expect(await index.listActiveCases(projectId)).toHaveLength(2);

      const updated = await index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/posts/create.feature',
        blobSha: 'blob-2',
        moduleKey: 'posts',
        tags: ['module:posts'],
        scenarios: [scenario('POST-001', 'Create post through API', 4, 'posts')],
      });
      expect(updated).toMatchObject({ active: 1, obsolete: 1 });
      expect(await index.listActiveCases(projectId)).toHaveLength(1);
      expect((await index.listObsoleteCases(projectId))[0]?.caseKey).toBe('POST-002');
      expect(
        (await index.searchCases(projectId, 'List posts')).map((item) => item.caseKey),
      ).not.toContain('POST-002');

      const marked = await index.markMissingFiles(
        projectId,
        'suite',
        new Set(['features/posts/other.feature']),
      );
      expect(marked).toBe(1);
      expect(await index.listObsoleteCases(projectId)).toHaveLength(2);
      expect((await index.listFeatureFiles(projectId))[0]).toMatchObject({
        parseStatus: 'missing',
      });
    } finally {
      await database.cleanup();
    }
  });

  it('matches underscores literally instead of as LIKE wildcards', async () => {
    const { database, index, projectId } = await setup();

    try {
      await index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/posts/create.feature',
        blobSha: 'blob-1',
        moduleKey: 'posts',
        tags: ['module:posts'],
        scenarios: [
          scenario('POST-001', 'Create post through API', 4, 'posts'),
          scenario('POST-002', 'create_post', 12, 'posts'),
        ],
      });

      // 未转义时 `_` 会退化为单字符通配符，两条用例都会被命中。
      const matched = await index.searchCases(projectId, '_');

      expect(matched.map((item) => item.caseKey)).toEqual(['POST-002']);
    } finally {
      await database.cleanup();
    }
  });

  it('falls back to module listing when the query has no tokens', async () => {
    const { database, index, projectId } = await setup();

    try {
      await index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/auth/login.feature',
        blobSha: null,
        moduleKey: 'auth',
        tags: ['module:auth'],
        scenarios: [scenario('AUTH-001', 'Login with password', 3, 'auth')],
      });

      expect(await index.searchCases(projectId, '  ', ['auth'])).toHaveLength(1);
      expect(await index.searchCases(projectId, '  ', ['posts'])).toHaveLength(0);
    } finally {
      await database.cleanup();
    }
  });
});
