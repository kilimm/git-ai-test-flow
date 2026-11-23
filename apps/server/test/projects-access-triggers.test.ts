// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvironmentRepository,
  GenerationRepository,
  JobQueue,
  ProjectRepository,
  RunRepository,
} from '@gait/db';

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
  environmentId: string;
}> {
  const context = await createTestApp();
  contexts.push(context);
  const tenant = await seedTenant(context.database.db);
  await seedUser(context.database.db, {
    username: 'owner',
    tenantId: tenant.id,
    role: 'owner',
  });
  await seedUser(context.database.db, {
    username: 'viewer',
    tenantId: tenant.id,
    role: 'viewer',
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
    deployedSha: 'a'.repeat(40),
    strictVersionMatch: false,
    envVarsJson: '{}',
    browserJson: '{}',
    caseTimeoutMs: 30_000,
    apiConcurrency: 2,
    uiConcurrency: 1,
    isDefault: true,
  });

  return {
    context,
    tenantId: tenant.id,
    projectId: project.id,
    environmentId: environment.id,
  };
}

describe('project-level access', () => {
  it('restricts project list/detail to members after switching to restricted mode', async () => {
    const { context, tenantId, projectId } = await setup();
    const owner = await login(context.app, 'owner', TEST_PASSWORD);
    const viewer = await login(context.app, 'viewer', TEST_PASSWORD);

    expect(
      (
        await authedRequest(context.app, {
          method: 'GET',
          url: `/api/v1/projects/${projectId}`,
          session: viewer,
        })
      ).statusCode,
    ).toBe(200);

    const restricted = await authedRequest(context.app, {
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/access`,
      session: owner,
      payload: { accessMode: 'restricted' },
    });

    expect(restricted.statusCode).toBe(200);
    expect((restricted.json() as { access: { accessMode: string } }).access.accessMode).toBe(
      'restricted',
    );

    const denied = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}`,
      session: viewer,
    });
    expect(denied.statusCode).toBe(404);
    const run = await new RunRepository(context.database.db, tenantId).create({
      projectId,
      headSha: 'e'.repeat(40),
      status: 'failed',
      idempotencyKey: 'project-access-run',
    });
    const hiddenRun = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/runs/${run.id}`,
      session: viewer,
    });
    expect(hiddenRun.statusCode).toBe(404);

    // /notifications 通过 query 反查项目，同样不能绕过 restricted 项目的访问控制。
    const hiddenNotifications = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/notifications?projectId=${projectId}`,
      session: viewer,
    });
    expect(hiddenNotifications.statusCode).toBe(404);
    const hiddenRunNotifications = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/notifications?runId=${run.id}`,
      session: viewer,
    });
    expect(hiddenRunNotifications.statusCode).toBe(404);

    const list = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/projects`,
      session: viewer,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);

    const added = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/members`,
      session: owner,
      payload: { username: 'viewer', role: 'viewer' },
    });
    expect(added.statusCode).toBe(200);

    const allowed = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}`,
      session: viewer,
    });
    expect(allowed.statusCode).toBe(200);

    const cannotManage = await authedRequest(context.app, {
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/access`,
      session: viewer,
      payload: { accessMode: 'tenant' },
    });
    expect(cannotManage.statusCode).toBe(403);
  });
});

describe('triggers and public webhooks', () => {
  it('creates tokenized deployment triggers, is idempotent and rejects bad tokens', async () => {
    const { context, projectId, tenantId } = await setup();
    const owner = await login(context.app, 'owner', TEST_PASSWORD);
    const created = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/triggers`,
      session: owner,
      payload: {
        name: 'deploy callback',
        type: 'deployment',
        action: 'run',
        selection: { type: 'all' },
      },
    });
    const createdBody = created.json() as {
      trigger: { id: string; action: string };
      token: string;
    };

    expect(created.statusCode).toBe(201);
    expect(createdBody.token).toMatch(/^gait_trg_/);

    const list = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${projectId}/triggers`,
      session: owner,
    });
    expect(JSON.stringify(list.json())).not.toContain(createdBody.token);
    expect(JSON.stringify(list.json())).not.toContain('tokenHash');

    const headSha = 'b'.repeat(40);
    const deployment = await context.app.inject({
      method: 'POST',
      url: `/webhooks/deploy/${projectId}`,
      headers: { authorization: `Bearer ${createdBody.token}` },
      payload: { headSha, branch: 'main' },
    });
    const deploymentBody = deployment.json() as { kind: string; created: boolean; id: string };

    expect(deployment.statusCode).toBe(200);
    expect(deploymentBody.kind).toBe('run');
    expect(deploymentBody.created).toBe(true);
    expect(
      await new RunRepository(context.database.db, tenantId).findById(deploymentBody.id),
    ).toBeDefined();

    const again = await context.app.inject({
      method: 'POST',
      url: `/webhooks/deploy/${projectId}`,
      headers: { authorization: `Bearer ${createdBody.token}` },
      payload: { headSha },
    });
    expect((again.json() as { created: boolean }).created).toBe(false);

    const invalid = await context.app.inject({
      method: 'POST',
      url: `/webhooks/deploy/${projectId}`,
      headers: { authorization: 'Bearer invalid-token' },
      payload: { headSha },
    });
    expect(invalid.statusCode).toBe(401);
    expect((invalid.json() as { code: string }).code).toBe('WEBHOOK_TOKEN_INVALID');
  });

  it('creates generation tasks from git webhooks and schedules them', async () => {
    const { context, projectId, tenantId } = await setup();
    const owner = await login(context.app, 'owner', TEST_PASSWORD);
    const created = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/triggers`,
      session: owner,
      payload: {
        name: 'push generate',
        type: 'git_webhook',
        action: 'generate',
        selection: { type: 'modules', modules: ['posts'] },
      },
    });
    const token = (created.json() as { token: string }).token;
    const webhook = await context.app.inject({
      method: 'POST',
      url: `/webhooks/git/${projectId}`,
      headers: { 'x-gait-token': token },
      payload: { after: 'c'.repeat(40), ref: 'refs/heads/main' },
    });
    const body = webhook.json() as { kind: string; id: string; created: boolean };

    expect(webhook.statusCode).toBe(200);
    expect(body.kind).toBe('generation');
    expect(body.created).toBe(true);
    const generation = await new GenerationRepository(context.database.db, tenantId).findById(
      body.id,
    );
    expect(generation?.trigger).toBe('webhook');

    const scheduled = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${projectId}/triggers`,
      session: owner,
      payload: {
        name: 'nightly',
        type: 'schedule',
        action: 'run',
        cron: '0 2 * * *',
        selection: { type: 'all' },
      },
    });
    const scheduledBody = scheduled.json() as {
      trigger: { nextRunAt: string | null };
      token: string | null;
    };

    expect(scheduled.statusCode).toBe(201);
    expect(scheduledBody.token).toBeNull();
    expect(scheduledBody.trigger.nextRunAt).toBeTruthy();
    expect((await new JobQueue(context.database.db).stats()).byStatus['queued']).toBe(1);
  });
});
