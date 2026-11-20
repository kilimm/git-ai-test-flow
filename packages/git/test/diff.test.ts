// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectCurrentDiff,
  collectRangeDiff,
  filterDiffFiles,
  listCommits,
  parsePatchHunks,
  resolveCommit,
  runGit,
} from '../src/index.js';
import type { DiffFile } from '@gait/shared';

const directories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

async function initRepository(directory: string): Promise<void> {
  await runGit(['init', '-b', 'main'], { cwd: directory });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: directory });
}

function write(directory: string, path: string, content: string | Buffer): void {
  const absolute = join(directory, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

async function commitAll(directory: string, message: string): Promise<string> {
  await runGit(['add', '-A'], { cwd: directory });
  await runGit(['commit', '-m', message], { cwd: directory });

  return (await runGit(['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('git diff collection', () => {
  it('collects range commits, patches, hunks and renames', async () => {
    const repo = makeDirectory('gait-diff-');
    await initRepository(repo);
    write(repo, 'src/api/posts.ts', 'export const list = () => [];\n');
    write(repo, 'src/legacy.ts', 'export const legacy = 1;\n');
    const base = await commitAll(repo, 'chore: initial');
    write(
      repo,
      'src/api/posts.ts',
      [
        'export const list = () => [];',
        '',
        'export const create = (title: string) => ({ title });',
        '',
      ].join('\n'),
    );
    write(repo, 'src/api/new-endpoint.ts', 'export const handler = () => 201;\n');
    await runGit(['mv', 'src/legacy.ts', 'src/legacy-renamed.ts'], { cwd: repo });
    const head = await commitAll(repo, 'feat(api): add create post');

    const result = await collectRangeDiff({ repoPath: repo, baseSha: base, headSha: head });

    expect(result.mode).toBe('range');
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]?.title).toBe('feat(api): add create post');
    expect(result.baseSha).toBe(base);
    expect(result.headSha).toBe(head);

    const modified = result.files.find((file) => file.path === 'src/api/posts.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBeGreaterThanOrEqual(2);
    expect(modified?.hunks.length).toBeGreaterThan(0);
    expect(modified?.patch).toContain('+export const create');

    const added = result.files.find((file) => file.path === 'src/api/new-endpoint.ts');
    expect(added?.status).toBe('added');

    const renamed = result.files.find((file) => file.path === 'src/legacy-renamed.ts');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/legacy.ts');

    const commits = await listCommits(repo, base, head);
    expect(commits.map((commit) => commit.sha)).toEqual([head]);
    await expect(resolveCommit(repo, 'HEAD')).resolves.toBe(head);
  });

  it('supports current-mode working tree changes', async () => {
    const repo = makeDirectory('gait-diff-current-');
    await initRepository(repo);
    write(repo, 'src/config.ts', 'export const timeout = 1;\n');
    const head = await commitAll(repo, 'chore: initial');
    write(repo, 'src/config.ts', 'export const timeout = 2;\n');

    const result = await collectCurrentDiff({ repoPath: repo });

    expect(result.mode).toBe('current');
    expect(result.headSha).toBe(head);
    expect(result.commits).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/config.ts');
    expect(result.files[0]?.patch).toContain('+export const timeout = 2');
  });

  it('parses hunk headers and omitted line counts', () => {
    const hunks = parsePatchHunks(
      [
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '@@ -10,2 +10,3 @@ context',
        ' line',
        '+added',
        '-removed',
      ].join('\n'),
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 });
    expect(hunks[1]?.content).toContain('+added');
  });
});

function diffFile(overrides: Partial<DiffFile> & Pick<DiffFile, 'path'>): DiffFile {
  return {
    oldPath: null,
    status: 'modified',
    category: 'other',
    binary: false,
    isDoc: false,
    isTest: false,
    isOpenApi: false,
    isSensitive: false,
    skipped: false,
    skipReason: null,
    truncated: false,
    sizeBytes: 10,
    additions: 1,
    deletions: 0,
    patch: 'diff --git a/file b/file\n+x\n',
    hunks: [],
    ...overrides,
  };
}

describe('diff filtering', () => {
  it('classifies files and skips sensitive, lock, generated and binary content', () => {
    const files = [
      diffFile({ path: 'src/api/posts.controller.ts', patch: '+controller' }),
      diffFile({ path: 'src/pages/post.tsx', patch: '+page' }),
      diffFile({ path: 'migrations/001_add_posts.sql', patch: '+sql' }),
      diffFile({ path: 'docs/readme.md', patch: '+doc' }),
      diffFile({ path: 'openapi/posts.yaml', patch: '+openapi' }),
      diffFile({ path: 'pnpm-lock.yaml', patch: '+lock' }),
      diffFile({ path: '.env', patch: 'SECRET=value' }),
      diffFile({ path: 'assets/logo.png', patch: '' }),
      diffFile({ path: 'src/posts.test.ts', patch: '+test' }),
      diffFile({ path: 'dist/app.js', patch: '+built' }),
    ];

    const result = filterDiffFiles(files);
    const byPath = new Map(result.files.map((file) => [file.path, file]));

    expect(byPath.get('src/api/posts.controller.ts')).toMatchObject({
      category: 'api',
      skipped: false,
    });
    expect(byPath.get('src/pages/post.tsx')).toMatchObject({ category: 'frontend' });
    expect(byPath.get('migrations/001_add_posts.sql')).toMatchObject({ category: 'database' });
    expect(byPath.get('docs/readme.md')).toMatchObject({ category: 'docs', isDoc: true });
    expect(byPath.get('openapi/posts.yaml')).toMatchObject({
      category: 'api',
      isOpenApi: true,
      isDoc: true,
    });
    expect(byPath.get('pnpm-lock.yaml')).toMatchObject({
      skipped: true,
      skipReason: 'lockfile',
    });
    expect(byPath.get('.env')).toMatchObject({
      skipped: true,
      skipReason: 'sensitive',
      patch: '',
    });
    expect(byPath.get('.env')?.isSensitive).toBe(true);
    expect(byPath.get('assets/logo.png')).toMatchObject({
      skipped: true,
      skipReason: 'binary',
    });
    expect(byPath.get('src/posts.test.ts')).toMatchObject({
      skipped: true,
      skipReason: 'test',
    });
    expect(byPath.get('dist/app.js')).toMatchObject({
      skipped: true,
      skipReason: 'generated',
    });
    expect(result.stats.sensitiveFiles).toBe(1);
    expect(result.stats.skippedByReason.sensitive).toBe(1);
  });

  it('truncates large files and enforces the total budget by category priority', () => {
    const large = diffFile({
      path: 'src/api/large.ts',
      patch: 'x'.repeat(500),
      sizeBytes: 500,
    });
    const docs = diffFile({
      path: 'docs/huge.md',
      patch: 'd'.repeat(500),
      sizeBytes: 500,
    });
    const result = filterDiffFiles([large, docs], { maxFileBytes: 100, maxTotalBytes: 800 });

    expect(result.files[0]?.truncated).toBe(true);
    expect(result.files[0]?.patch).toHaveLength(100);
    expect(result.files[0]?.skipped).toBe(false);
    expect(result.files[1]?.skipped).toBe(true);
    expect(result.files[1]?.skipReason).toBe('total-budget');
    expect(result.stats.truncatedFiles).toBe(1);
    expect(result.stats.includedFiles).toBe(1);
  });
});
