// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunRepository,
} from '@gait/db';
import { SuiteRepository } from '@gait/git';
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
const directories: string[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await closeTestApp(context);
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('repair approval API', () => {
  it('approves a high-risk patch into the Suite, then rolls it back', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gait-repair-'));
    directories.push(dataDir);
    const context = await createTestApp({ envOverrides: { DATA_DIR: dataDir } });
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
    const original = [
      '@module:posts @layer:api',
      'Feature: Posts',
      '  @case:API-1',
      '  Scenario: list',
      '    When I send a GET request to "/api/items"',
      '    Then the response status should be 200',
      '',
    ].join('\n');
    const patched = original.replace('should be 200', 'should be 201');
    const suite = await SuiteRepository.open({
      mode: 'managed',
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir,
    });

    await suite.writeAndCommit(
      [{ path: 'features/api/posts.feature', content: original }],
      'test: seed feature',
    );
    await suite.dispose();
    const run = new RunRepository(context.database.db, tenant.id).create({
      projectId: project.id,
      headSha: 'a'.repeat(40),
      status: 'failed',
      idempotencyKey: 'repair-run-1',
    });
    const runCase = new RunCaseRepository(context.database.db, tenant.id).createMany([
      {
        runId: run.id,
        featurePath: 'features/api/posts.feature',
        scenarioName: 'list',
        line: 4,
        caseKey: 'API-1',
        status: 'failed',
      },
    ])[0];

    if (runCase === undefined) {
      throw new Error('run case seed failed');
    }

    const repairs = new RepairAttemptRepository(context.database.db, tenant.id);
    const repair = repairs.create({
      runCaseId: runCase.id,
      attemptNo: 1,
      originalContent: original,
      patchedContent: patched,
      patchDiff: '--- a/features/api/posts.feature\n+++ b/features/api/posts.feature',
      repairClass: 'expectation_update',
      rationale: 'API behavior changed with evidence',
      guardStatus: 'human_required',
      guardFindings: [],
      reviewStatus: 'pending',
      featurePath: 'features/api/posts.feature',
    });
    const session = await login(context.app, 'owner', TEST_PASSWORD);
    const approved = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/run-cases/${runCase.id}/repairs/${repair.id}/approve`,
      session,
      payload: {},
    });
    const body = approved.json() as {
      repair: { reviewStatus: string; appliedCommit: string | null };
    };

    expect(approved.statusCode).toBe(200);
    expect(body.repair.reviewStatus).toBe('approved');
    expect(body.repair.appliedCommit).toBeTruthy();

    const after = await SuiteRepository.open({
      mode: 'managed',
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir,
    });

    expect(after.readFile('features/api/posts.feature')).toBe(patched);
    await after.dispose();

    const rollback = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/run-cases/${runCase.id}/repairs/${repair.id}/rollback`,
      session,
      payload: {},
    });

    expect(rollback.statusCode).toBe(200);
    expect(
      (rollback.json() as { repair: { appliedCommit: string | null } }).repair.appliedCommit,
    ).toBeNull();

    const restored = await SuiteRepository.open({
      mode: 'managed',
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir,
    });

    expect(restored.readFile('features/api/posts.feature')).toBe(original);
    await restored.dispose();
  });
});
