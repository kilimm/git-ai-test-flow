// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvironmentRepository,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
} from '@gait/db';
import { formatSseMessage } from '../src/api/sse.js';
import {
  closeTestApp,
  cookieHeader,
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

describe('SSE events', () => {
  it('formats id/event/data and handles multiline data as JSON', () => {
    expect(formatSseMessage({ id: 3, event: 'step.finished', data: { status: 'passed' } })).toBe(
      'id: 3\nevent: step.finished\ndata: {"status":"passed"}\n\n',
    );
  });

  it('streams run_events and closes after a terminal run with Last-Event-ID', async () => {
    const context = await createTestApp();
    contexts.push(context);
    const tenant = await seedTenant(context.database.db);
    await seedUser(context.database.db, {
      username: 'owner',
      tenantId: tenant.id,
      role: 'owner',
    });
    const project = await new ProjectRepository(context.database.db, tenant.id).create({
      name: 'Demo',
      slug: 'demo',
      productRepoUrl: 'https://example.com/demo.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });
    const environment = await new EnvironmentRepository(context.database.db, tenant.id).create({
      projectId: project.id,
      name: 'staging',
      apiBaseUrl: 'http://127.0.0.1:1',
      healthcheckExpectedStatus: 200,
      healthcheckTimeoutMs: 5_000,
      versionSource: 'manual',
      strictVersionMatch: false,
      envVarsJson: '{}',
      browserJson: '{}',
      caseTimeoutMs: 30_000,
      apiConcurrency: 2,
      uiConcurrency: 1,
      isDefault: true,
    });
    const run = await new RunRepository(context.database.db, tenant.id).create({
      projectId: project.id,
      environmentId: environment.id,
      headSha: 'a'.repeat(40),
      status: 'failed',
      idempotencyKey: 'sse-run-1',
      statsJson: JSON.stringify({ total: 1, passed: 0, failed: 1 }),
    });
    await new RunEventRepository(context.database.db, tenant.id).append({
      runId: run.id,
      type: 'run.finished',
      payload: { runId: run.id, status: 'failed' },
    });
    const session = await login(context.app, 'owner', TEST_PASSWORD);
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events`,
      headers: { cookie: cookieHeader(session.cookies) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: run.finished');
    expect(response.body).toContain('"status":"failed"');

    const resumed = await context.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${run.id}/events`,
      headers: {
        cookie: cookieHeader(session.cookies),
        'last-event-id': '1',
      },
    });

    expect(resumed.body).toContain('event: run.snapshot');
    expect(resumed.body).not.toContain('event: run.finished');
  });

  it('rejects appending events to a Run owned by another tenant', async () => {
    const context = await createTestApp();
    contexts.push(context);
    const tenant = await seedTenant(context.database.db);
    const other = await seedTenant(context.database.db, 'globex', 'Globex');
    const project = await new ProjectRepository(context.database.db, tenant.id).create({
      name: 'Demo',
      slug: 'demo',
      productRepoUrl: 'https://example.com/demo.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });
    const run = await new RunRepository(context.database.db, tenant.id).create({
      projectId: project.id,
      headSha: 'a'.repeat(40),
      idempotencyKey: 'sse-cross-tenant',
    });

    await expect(
      new RunEventRepository(context.database.db, other.id).append({
        runId: run.id,
        type: 'run.finished',
      }),
    ).rejects.toThrow('Run not found');
    expect(
      await new RunEventRepository(context.database.db, tenant.id).listByRun(run.id),
    ).toHaveLength(0);
  });
});
