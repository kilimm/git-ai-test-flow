// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationRepository, RunCaseRepository, RunRepository } from '@gait/db';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import { createEnvironment, createProject, seedActor } from './config-helpers.js';
import type { SeededActor } from './config-helpers.js';

async function withRunApp(
  run: (context: TestAppContext, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gait-run-api-'));
  const context = await createTestApp({ envOverrides: { DATA_DIR: dataDir } });

  try {
    await run(context, dataDir);
  } finally {
    await closeTestApp(context);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function actorWithEnvironment(context: TestAppContext): Promise<{
  actor: SeededActor;
  projectId: string;
  environmentId: string;
}> {
  const actor = await seedActor(context, { slug: 'acme', username: 'owner', role: 'owner' });
  const projectId = ((await createProject(context, actor)).json() as { project: { id: string } })
    .project.id;
  const environment = (
    (await createEnvironment(context, actor, projectId)).json() as {
      environment: { id: string };
    }
  ).environment;

  return { actor, projectId, environmentId: environment.id };
}

function createRun(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  payload: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof authedRequest>>> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/runs`,
    session: actor.session,
    payload: {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      ...payload,
    },
  });
}

describe('run API', () => {
  it('creates an idempotent run, exposes details and cancels it', async () => {
    await withRunApp(async (context) => {
      const { actor, projectId, environmentId } = await actorWithEnvironment(context);
      const first = await createRun(context, actor, projectId, {
        environmentId,
        selection: { type: 'modules', modules: ['auth'] },
      });

      expect(first.statusCode).toBe(201);
      const created = first.json() as {
        run: { id: string; status: string; environmentId: string; namespace: string };
        created: boolean;
      };

      expect(created.created).toBe(true);
      expect(created.run.status).toBe('queued');
      expect(created.run.environmentId).toBe(environmentId);
      expect(created.run.namespace).toMatch(/^run_[0-9a-f]{8}_$/);

      const job = context.database.sqlite
        .prepare('SELECT type, payload_json FROM jobs WHERE dedupe_key = ?')
        .get(`run:${created.run.id}`) as { type: string; payload_json: string } | undefined;

      expect(job?.type).toBe('run.execute');
      expect(job?.payload_json).toContain(created.run.id);

      const duplicate = await createRun(context, actor, projectId, {
        environmentId,
        selection: { type: 'modules', modules: ['auth'] },
      });

      expect(duplicate.statusCode).toBe(200);
      expect((duplicate.json() as { created: boolean }).created).toBe(false);
      expect((duplicate.json() as { run: { id: string } }).run.id).toBe(created.run.id);

      const detail = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}`,
        session: actor.session,
      });

      expect(detail.statusCode).toBe(200);
      expect((detail.json() as { run: { cases: unknown[] } }).run.cases).toEqual([]);

      const canceled = await authedRequest(context.app, {
        method: 'POST',
        url: `/api/v1/runs/${created.run.id}/cancel`,
        session: actor.session,
      });

      expect(canceled.statusCode).toBe(200);
      expect((canceled.json() as { run: { status: string } }).run.status).toBe('canceled');

      const again = await authedRequest(context.app, {
        method: 'POST',
        url: `/api/v1/runs/${created.run.id}/cancel`,
        session: actor.session,
      });

      expect(again.statusCode).toBe(409);

      const stored = new RunRepository(context.database.db, actor.tenant.id).findById(
        created.run.id,
      );

      expect(stored?.status).toBe('canceled');
    });
  });

  it('uses the default environment and rejects invalid selections', async () => {
    await withRunApp(async (context) => {
      const { actor, projectId } = await actorWithEnvironment(context);
      const implicit = await createRun(context, actor, projectId);

      expect(implicit.statusCode).toBe(201);

      const invalid = await createRun(context, actor, projectId, {
        selection: { type: 'modules', modules: [] },
      });

      expect(invalid.statusCode).toBe(400);
      expect((invalid.json() as { code: string }).code).toBe('VALIDATION_ERROR');

      const badSha = await createRun(context, actor, projectId, { headSha: 'not-a-sha' });

      expect(badSha.statusCode).toBe(400);
    });
  });

  it('serves JSON/Markdown/HTML/JUnit reports and notification records', async () => {
    await withRunApp(async (context) => {
      const { actor, projectId, environmentId } = await actorWithEnvironment(context);
      const created = (await createRun(context, actor, projectId, { environmentId })).json() as {
        run: { id: string };
      };
      const runRepository = new RunRepository(context.database.db, actor.tenant.id);
      const caseRepository = new RunCaseRepository(context.database.db, actor.tenant.id);
      const runCase = caseRepository.createMany([
        {
          runId: created.run.id,
          featurePath: 'features/api/posts.feature',
          scenarioName: 'create post',
          caseKey: 'POST-001',
          tags: ['layer:api'],
          layer: 'api',
          status: 'failed',
        },
      ])[0];

      if (runCase === undefined) {
        throw new Error('run case seed failed');
      }

      caseRepository.update(runCase.id, {
        classification: 'code_bug',
        confidence: 82,
        errorMessage: 'expected 400 but received 500',
        evidenceJson: JSON.stringify({
          attribution: {
            verdict: 'code_bug',
            confidence: 0.82,
            rootCause: '接口返回 500',
            evidenceRefs: ['step:1'],
            suggestedFix: null,
            testRepairAllowed: false,
            source: 'rule',
            conflict: null,
          },
          evidence: { version: 1, codeLocations: [] },
        }),
      });
      runRepository.update(created.run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        statsJson: JSON.stringify({
          total: 1,
          passed: 0,
          failed: 1,
          error: 0,
          skipped: 0,
          durationMs: 1_000,
        }),
      });
      new NotificationRepository(context.database.db, actor.tenant.id).create({
        projectId,
        runId: created.run.id,
        eventType: 'run_failed',
        status: 'sent',
        dedupeKey: `${created.run.id}:channel-1:run_failed`,
      });

      const json = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}/report`,
        session: actor.session,
      });
      const markdown = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}/report?format=markdown&download=1`,
        session: actor.session,
      });
      const html = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}/report?format=html`,
        session: actor.session,
      });
      const junit = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}/report?format=junit`,
        session: actor.session,
      });
      const notifications = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/notifications?runId=${created.run.id}`,
        session: actor.session,
      });

      expect(json.statusCode).toBe(200);
      expect(
        (json.json() as { report: { overview: { runId: string } } }).report.overview.runId,
      ).toBe(created.run.id);
      expect(markdown.statusCode).toBe(200);
      expect(markdown.headers['content-type']).toContain('text/markdown');
      expect(markdown.headers['content-disposition']).toContain('attachment');
      expect(markdown.body).toContain('代码缺陷');
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.body).toContain('<table>');
      expect(junit.headers['content-type']).toContain('xml');
      expect(junit.body).toContain('<testsuites');
      expect((notifications.json() as { items: { status: string }[] }).items[0]?.status).toBe(
        'sent',
      );

      const other = await seedActor(context, {
        slug: 'beta',
        username: 'beta-owner',
        role: 'owner',
      });
      const crossTenant = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${created.run.id}/report`,
        session: other.session,
      });

      expect(crossTenant.statusCode).toBe(404);
    });
  });

  it('isolates runs across tenants and enforces RBAC', async () => {
    await withRunApp(async (context) => {
      const owner = await actorWithEnvironment(context);
      const run = (await createRun(context, owner.actor, owner.projectId)).json() as {
        run: { id: string };
      };
      const other = await seedActor(context, {
        slug: 'beta',
        username: 'beta-owner',
        role: 'owner',
      });
      const crossTenant = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/runs/${run.run.id}`,
        session: other.session,
      });

      expect(crossTenant.statusCode).toBe(404);

      await seedUser(context.database.db, {
        username: 'viewer',
        tenantId: owner.actor.tenant.id,
        role: 'viewer',
        password: TEST_PASSWORD,
      });
      const viewerSession = await login(context.app, 'viewer', TEST_PASSWORD);
      const forbidden = await authedRequest(context.app, {
        method: 'POST',
        url: `/api/v1/projects/${owner.projectId}/runs`,
        session: viewerSession,
        payload: { headSha: 'a'.repeat(40), environmentId: owner.environmentId },
      });

      expect(forbidden.statusCode).toBe(403);
    });
  });
});
