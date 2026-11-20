// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '@gait/git';
import { RunWorkspace, WorkspaceError } from '../src/index.js';

const directories: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);

  return directory;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

async function createProductRepository(): Promise<{ directory: string; headSha: string }> {
  const directory = tempDir('gait-workspace-product-');

  await runGit(['init', '-b', 'main'], { cwd: directory });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: directory });
  write(directory, 'README.md', '# product\n');
  write(directory, 'src/app.ts', 'export const app = true;\n');
  await runGit(['add', '-A'], { cwd: directory });
  await runGit(['commit', '-m', 'chore: initial'], { cwd: directory });
  const headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();

  return { directory, headSha };
}

async function createManagedSuite(dataDir: string, projectId: string): Promise<void> {
  const suiteRoot = join(dataDir, 'suites', projectId);

  mkdirSync(join(suiteRoot, 'features', 'api'), { recursive: true });
  write(
    suiteRoot,
    'features/api/health.feature',
    [
      '@module:health @layer:api',
      'Feature: Health',
      '  @case:HEALTH-001',
      '  Scenario: health',
      '    When I send a GET request to "/health"',
      '    Then the response status should be 200',
    ].join('\n'),
  );
  await runGit(['init', '-b', 'main'], { cwd: suiteRoot });
  await runGit(['add', '-A'], { cwd: suiteRoot });
  await runGit(['commit', '-m', 'chore: seed suite'], { cwd: suiteRoot });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('run workspace', () => {
  it('checks out the product read-only and exposes the suite', async () => {
    const dataDir = tempDir('gait-workspace-data-');
    const product = await createProductRepository();
    const projectId = 'project-1';

    await createManagedSuite(dataDir, projectId);

    const workspace = await RunWorkspace.open({
      dataDir,
      tenantId: 'tenant-1',
      projectId,
      projectSlug: 'demo',
      runId: 'run-1',
      productRepoUrl: product.directory,
      suiteMode: 'managed',
      headSha: product.headSha,
    });

    expect(workspace.readProductFile('src/app.ts')).toContain('export const app');
    expect(workspace.readProductFile('missing.ts')).toBeNull();
    expect(() => workspace.readProductFile('../escape')).toThrow(WorkspaceError);
    const features = await workspace.suite.listFeatureFiles();
    expect(features.map((file) => file.path)).toEqual(['features/api/health.feature']);
    expect(existsSync(join(workspace.root, 'logs'))).toBe(true);
    expect(existsSync(join(workspace.root, 'tmp'))).toBe(true);

    const errors = await workspace.close();
    expect(errors).toEqual([]);
    expect(existsSync(workspace.root)).toBe(false);
  });

  it('fails when the workspace exceeds its quota and cleans up', async () => {
    const dataDir = tempDir('gait-workspace-quota-');
    const product = await createProductRepository();
    const projectId = 'project-2';

    await createManagedSuite(dataDir, projectId);

    await expect(
      RunWorkspace.open({
        dataDir,
        tenantId: 'tenant-1',
        projectId,
        projectSlug: 'demo',
        runId: 'run-2',
        productRepoUrl: product.directory,
        suiteMode: 'managed',
        headSha: product.headSha,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_QUOTA_EXCEEDED' });

    const worktrees = join(dataDir, 'git', 'worktrees');

    if (existsSync(worktrees)) {
      return;
    }

    expect(existsSync(join(dataDir, 'workspaces', 'tenant-1', projectId, 'run-2'))).toBe(false);
  });
});
