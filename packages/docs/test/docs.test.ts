// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import {
  compressDocEntries,
  globToRegExp,
  inferModules,
  moduleForPath,
  parseModuleManifest,
  renderModuleManifest,
  syncProjectDocs,
} from '../src/index.js';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { ProjectRepository, TenantRepository } from '@gait/db';
import type { DocCommitEntry } from '@gait/shared';
import { DocRepository } from '@gait/db';

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

function entry(index: number): DocCommitEntry {
  return {
    commitSha: `sha-${String(index).padStart(4, '0')}`,
    committedAt: Date.UTC(2025, 0, 1) + index * 60_000,
    author: 'dev',
    title: `change ${index}`,
    summaryMd: `summary ${index}`,
    detailMd: `detail ${index}`,
    files: ['src/posts/index.ts'],
    modules: ['posts'],
    tokenCount: 5,
  };
}

describe('document module manifest', () => {
  it('parses, renders and validates module patterns', () => {
    const manifest = parseModuleManifest(`
modules:
  - key: posts
    name: 帖子
    description: 帖子模块
    pathPatterns: ["src/posts/**", "src/api/posts/**"]
    owner: content
    dependsOn: [auth]
`);

    expect(manifest.modules).toHaveLength(1);
    expect(manifest.modules[0]?.key).toBe('posts');
    expect(renderModuleManifest(manifest.modules)).toContain('pathPatterns');
    expect(globToRegExp('src/**').test('src/posts/a.ts')).toBe(true);
    expect(moduleForPath(manifest.modules, 'src/api/posts/index.ts')?.key).toBe('posts');
    expect(moduleForPath(manifest.modules, 'src/users/index.ts')).toBeNull();
    expect(inferModules(['src/posts/a.ts', 'src/auth/login.ts']).map((item) => item.key)).toEqual([
      'auth',
      'posts',
    ]);
  });

  it('rejects duplicate or invalid modules', () => {
    expect(() =>
      parseModuleManifest('modules:\n  - key: A Bad Key\n    pathPatterns: ["src/**"]'),
    ).toThrow(/key is invalid/);
    expect(() =>
      parseModuleManifest(
        'modules:\n  - key: a\n    pathPatterns: ["src/**"]\n  - key: a\n    pathPatterns: ["x/**"]',
      ),
    ).toThrow(/Duplicate/);
    expect(() => parseModuleManifest('modules:\n  - key: a\n    pathPatterns: []')).toThrow(
      /pathPatterns/,
    );
  });
});

describe('document history compression', () => {
  it('keeps the newest 100 entries as T0 and builds T1/T2/T3 rollups', () => {
    const entries = Array.from({ length: 2_050 }, (_, index) => entry(index));
    const rollups = compressDocEntries(entries);
    const sources = rollups.flatMap((rollup) => rollup.sourceEntryIds);
    const newest = [...entries]
      .sort((left, right) => right.committedAt - left.committedAt)
      .slice(0, 100)
      .map((item) => item.commitSha);

    expect(rollups.every((rollup) => rollup.sourceEntryIds.length > 0)).toBe(true);
    expect(sources.some((sha) => newest.includes(sha))).toBe(false);
    expect(rollups.some((rollup) => rollup.tier === 'T1')).toBe(true);
    expect(rollups.some((rollup) => rollup.tier === 'T2')).toBe(true);
    expect(rollups.some((rollup) => rollup.tier === 'T3')).toBe(true);
    expect(rollups.every((rollup) => rollup.tokenCount > 0)).toBe(true);
  });

  it('does not create rollups when history is within 100 commits', () => {
    expect(compressDocEntries(Array.from({ length: 100 }, (_, index) => entry(index)))).toEqual([]);
  });
});

describe('document sync', () => {
  function setup(): { database: TestDatabase; tenantId: string; projectId: string } {
    const database = createTestDatabase();
    databases.push(database);
    const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
    const project = new ProjectRepository(database.db, tenant.id).create({
      name: 'Demo',
      slug: 'demo',
      productRepoUrl: 'https://example.com/demo.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });

    return { database, tenantId: tenant.id, projectId: project.id };
  }

  it('maps commits to modules, writes docs and persists versions', async () => {
    const { database, tenantId, projectId } = setup();
    const project = new ProjectRepository(database.db, tenantId).findById(projectId);
    const written = new Map<string, string>();

    if (project === undefined) {
      throw new Error('project seed failed');
    }

    const result = await syncProjectDocs({
      db: database.db,
      tenantId,
      project,
      headSha: 'head-1',
      repoFiles: ['src/posts/index.ts', 'src/auth/login.ts', 'README.md'],
      commits: [
        {
          sha: 'sha-a',
          committedAt: Date.UTC(2025, 1, 1),
          author: 'dev',
          title: 'feat: posts',
          files: ['src/posts/index.ts'],
        },
        {
          sha: 'sha-b',
          committedAt: Date.UTC(2025, 1, 2),
          author: 'dev',
          title: 'fix: auth',
          files: ['src/auth/login.ts'],
        },
      ],
      moduleManifest: [
        {
          key: 'posts',
          name: '帖子',
          description: '帖子模块',
          pathPatterns: ['src/posts/**'],
          owner: '',
          dependsOn: [],
        },
        {
          key: 'auth',
          name: '认证',
          description: '认证模块',
          pathPatterns: ['src/auth/**'],
          owner: '',
          dependsOn: [],
        },
      ],
      writeDoc: (path, content) => {
        written.set(path, content);
        return true;
      },
      now: Date.now(),
    });

    expect(result.entries).toHaveLength(2);
    expect(result.modules.map((item) => item.key).sort()).toEqual(['auth', 'posts']);
    expect(written.get('docs/ai/posts.md')).toContain('# 帖子');
    expect(written.get('docs/ai/auth.md')).toContain('fix: auth');
    expect(
      new DocRepository(database.db, tenantId).listVersions(
        new DocRepository(database.db, tenantId).findModuleByKey(projectId, 'posts')?.id ?? '',
      ),
    ).toHaveLength(1);
  });

  it('does not silently overwrite a human-edited document', async () => {
    const { database, tenantId, projectId } = setup();
    const project = new ProjectRepository(database.db, tenantId).findById(projectId);

    if (project === undefined) {
      throw new Error('project seed failed');
    }

    const repository = new DocRepository(database.db, tenantId);
    const module = repository.upsertModule({
      projectId,
      key: 'posts',
      name: '帖子',
      pathPatterns: ['src/posts/**'],
    });
    repository.createVersion({
      projectId,
      docModuleId: module.id,
      commitSha: 'manual',
      contentMd: '# Hand edited',
      contentHash: 'hash',
      humanEdited: true,
      status: 'committed',
    });
    const written = new Map<string, string>();
    const result = await syncProjectDocs({
      db: database.db,
      tenantId,
      project,
      headSha: 'head-2',
      repoFiles: ['src/posts/index.ts'],
      commits: [
        {
          sha: 'sha-c',
          committedAt: Date.UTC(2025, 2, 1),
          author: 'dev',
          title: 'feat: new posts',
          files: ['src/posts/index.ts'],
        },
      ],
      moduleManifest: [
        {
          key: 'posts',
          name: '帖子',
          description: '',
          pathPatterns: ['src/posts/**'],
          owner: '',
          dependsOn: [],
        },
      ],
      writeDoc: (path, content) => {
        written.set(path, content);
        return true;
      },
    });

    expect(result.conflicts).toContain('posts');
    expect(written.has('docs/ai/posts.md')).toBe(false);
  });
});
