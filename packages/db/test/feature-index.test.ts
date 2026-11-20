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

function setup(): {
  database: TestDatabase;
  index: FeatureIndexRepository;
  tenantId: string;
  projectId: string;
} {
  const database = createTestDatabase();
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

  return {
    database,
    index: new FeatureIndexRepository(database.db, tenant.id),
    tenantId: tenant.id,
    projectId: project.id,
  };
}

describe('feature index repository', () => {
  it('indexes scenarios, searches with FTS5 and marks removed cases obsolete', () => {
    const { database, index, projectId } = setup();

    try {
      const first = index.indexFeatureFile({
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

      expect(index.searchCases(projectId, 'create post').map((item) => item.caseKey)).toContain(
        'POST-001',
      );
      expect(index.searchCases(projectId, 'List posts').map((item) => item.caseKey)).toContain(
        'POST-002',
      );
      expect(index.searchCases(projectId, 'create', ['auth'])).toHaveLength(0);
      expect(index.searchCases(projectId, 'create', ['posts'])).toHaveLength(1);
      expect(index.listActiveCases(projectId)).toHaveLength(2);

      const updated = index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/posts/create.feature',
        blobSha: 'blob-2',
        moduleKey: 'posts',
        tags: ['module:posts'],
        scenarios: [scenario('POST-001', 'Create post through API', 4, 'posts')],
      });
      expect(updated).toMatchObject({ active: 1, obsolete: 1 });
      expect(index.listActiveCases(projectId)).toHaveLength(1);
      expect(index.listObsoleteCases(projectId)[0]?.caseKey).toBe('POST-002');
      expect(index.searchCases(projectId, 'List posts').map((item) => item.caseKey)).not.toContain(
        'POST-002',
      );

      const marked = index.markMissingFiles(
        projectId,
        'suite',
        new Set(['features/posts/other.feature']),
      );
      expect(marked).toBe(1);
      expect(index.listObsoleteCases(projectId)).toHaveLength(2);
      expect(index.listFeatureFiles(projectId)[0]).toMatchObject({ parseStatus: 'missing' });
    } finally {
      database.cleanup();
    }
  });

  it('falls back to module listing when the query has no tokens', () => {
    const { database, index, projectId } = setup();

    try {
      index.indexFeatureFile({
        projectId,
        repo: 'suite',
        path: 'features/auth/login.feature',
        blobSha: null,
        moduleKey: 'auth',
        tags: ['module:auth'],
        scenarios: [scenario('AUTH-001', 'Login with password', 3, 'auth')],
      });

      expect(index.searchCases(projectId, '  ', ['auth'])).toHaveLength(1);
      expect(index.searchCases(projectId, '  ', ['posts'])).toHaveLength(0);
    } finally {
      database.cleanup();
    }
  });
});
