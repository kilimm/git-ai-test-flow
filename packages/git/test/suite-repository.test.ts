// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SuiteRepository, runGit } from '../src/index.js';

const directories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

function write(directory: string, path: string, content: string): void {
  const absolute = join(directory, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

async function createSeedRepository(root: string, files: Record<string, string>): Promise<string> {
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: seed });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: seed });

  for (const [path, content] of Object.entries(files)) {
    write(seed, path, content);
  }

  await runGit(['add', '-A'], { cwd: seed });
  await runGit(['commit', '-m', 'chore: seed repository'], { cwd: seed });

  return (await runGit(['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
}

async function createBareRemote(
  root: string,
  files: Record<string, string>,
): Promise<{ remote: string; seedSha: string }> {
  const seedSha = await createSeedRepository(root, files);
  const remote = join(root, 'remote.git');
  await runGit(['clone', '--bare', join(root, 'seed'), remote]);

  return { remote, seedSha };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed suite repository', () => {
  it('initializes, commits feature files and is idempotent', async () => {
    const root = makeDirectory('gait-suite-managed-');
    const dataDir = join(root, 'data');
    const repository = await SuiteRepository.open({
      mode: 'managed',
      projectId: 'project-1',
      projectSlug: 'demo',
      projectRepoUrl: 'https://example.com/product.git',
      featureRoot: 'features',
      dataDir,
    });

    try {
      expect(repository.featurePrefix).toBe('features');
      expect(await repository.listFeatureFiles()).toEqual([]);

      const content = '@module:auth @layer:api @case:AUTH-001\nFeature: Login\n';
      const first = await repository.writeAndCommit(
        [{ path: 'features/auth/login.feature', content }],
        'feat: add login feature',
      );
      expect(first.changed).toBe(true);
      expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);

      const repeated = await repository.writeAndCommit(
        [{ path: 'features/auth/login.feature', content }],
        'feat: duplicate',
      );
      expect(repeated.changed).toBe(false);
      expect(repeated.commitSha).toBe(first.commitSha);

      const files = await repository.listFeatureFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'features/auth/login.feature',
        content,
      });
      expect(files[0]?.blobSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await repository.dispose();
    }

    const reopened = await SuiteRepository.open({
      mode: 'managed',
      projectId: 'project-1',
      projectSlug: 'demo',
      projectRepoUrl: 'https://example.com/product.git',
      featureRoot: 'features',
      dataDir,
    });
    expect(await reopened.listFeatureFiles()).toHaveLength(1);
    await expect(
      reopened.writeAndCommit([{ path: '../escape.feature', content: 'x' }], 'bad'),
    ).rejects.toThrow();
    await reopened.dispose();
  });
});

describe('external suite repository', () => {
  it('mirrors an external repository, commits and pushes', async () => {
    const root = makeDirectory('gait-suite-external-');
    const { remote } = await createBareRemote(root, {
      'features/.gitkeep': '',
      'steps/registry.json': '{"steps":[]}\n',
    });
    const repository = await SuiteRepository.open({
      mode: 'external',
      projectId: 'project-2',
      projectSlug: 'demo',
      projectRepoUrl: 'https://example.com/product.git',
      suiteRepoUrl: remote,
      featureRoot: 'features',
      dataDir: join(root, 'data'),
    });

    try {
      const content = '@module:posts @layer:api @case:POST-001\nFeature: Posts\n';
      const result = await repository.writeAndCommit(
        [{ path: 'features/posts/create.feature', content }],
        'feat: add posts feature',
      );
      expect(result.changed).toBe(true);

      const log = await runGit(['--git-dir', remote, 'log', 'main', '--format=%s']);
      expect(log.stdout).toContain('feat: add posts feature');

      const files = await repository.listFeatureFiles();
      expect(files.map((file) => file.path)).toContain('features/posts/create.feature');
    } finally {
      await repository.dispose();
    }
  });
});

describe('same-repo suite repository', () => {
  it('commits into the dedicated branch under suitePath', async () => {
    const root = makeDirectory('gait-suite-same-repo-');
    const { remote, seedSha } = await createBareRemote(root, {
      'src/app.ts': 'export const app = true;\n',
      '.ai-test/features/.gitkeep': '',
    });
    const dataDir = join(root, 'data');
    const repository = await SuiteRepository.open({
      mode: 'same_repo',
      projectId: 'project-3',
      projectSlug: 'demo',
      projectRepoUrl: remote,
      suitePath: '.ai-test',
      featureRoot: 'features',
      dataDir,
      headSha: seedSha,
    });

    try {
      expect(repository.featurePrefix).toBe('.ai-test/features');
      const content = '@module:auth @layer:ui @case:AUTH-UI-001\nFeature: Login\n';
      const result = await repository.writeAndCommit(
        [{ path: '.ai-test/features/auth/login.feature', content }],
        'feat: add suite feature',
      );
      expect(result.changed).toBe(true);
      expect(result.committedPaths).toEqual(['.ai-test/features/auth/login.feature']);

      const branch = await runGit([
        '--git-dir',
        remote,
        'show',
        'gait/ai-tests:.ai-test/features/auth/login.feature',
      ]);
      expect(branch.stdout).toContain('AUTH-UI-001');
    } finally {
      await repository.dispose();
    }

    const reopened = await SuiteRepository.open({
      mode: 'same_repo',
      projectId: 'project-3',
      projectSlug: 'demo',
      projectRepoUrl: remote,
      suitePath: '.ai-test',
      featureRoot: 'features',
      dataDir,
      headSha: seedSha,
    });
    expect((await reopened.listFeatureFiles()).map((file) => file.path)).toContain(
      '.ai-test/features/auth/login.feature',
    );
    await reopened.dispose();
  });
});
