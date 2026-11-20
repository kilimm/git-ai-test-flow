// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeatureIndexRepository, GenerationFileRepository, GenerationRepository } from '@gait/db';
import { runGit } from '@gait/git';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import { createProject, seedActor } from './config-helpers.js';
import type { SeededActor } from './config-helpers.js';

const FEATURE = [
  '@module:auth @layer:api @risk:high @generated',
  'Feature: Auth API',
  '',
  '  @case:AUTH-API-001 @generated',
  '  Scenario: login succeeds',
  '    When I send a POST request to "/api/login" with JSON:',
  '      """json',
  '      {"username": "{{fixture.user.name}}"}',
  '      """',
  '    Then the response status should be 200',
].join('\n');

async function withGenerationApp(
  run: (context: TestAppContext, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gait-generation-api-'));
  const context = await createTestApp({ envOverrides: { DATA_DIR: dataDir } });

  try {
    await run(context, dataDir);
  } finally {
    await closeTestApp(context);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function actorWithProject(context: TestAppContext): Promise<{
  actor: SeededActor;
  projectId: string;
}> {
  const actor = await seedActor(context, {
    slug: 'acme',
    username: 'owner',
    role: 'owner',
  });
  const projectId = (
    (await createProject(context, actor)).json() as {
      project: { id: string };
    }
  ).project.id;

  return { actor, projectId };
}

function createGeneration(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  payload: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof authedRequest>>> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/generations`,
    session: actor.session,
    payload: {
      mode: 'range',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      branch: 'main',
      ...payload,
    },
  });
}

function seedAwaitingGeneration(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  id: string,
): void {
  const generation = new GenerationRepository(context.database.db, actor.tenant.id).create({
    id,
    projectId,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'main',
    mode: 'range',
    idempotencyKey: `seed:${id}`,
    status: 'awaiting_approval',
    createdByUserId: actor.user.id,
  });

  new GenerationFileRepository(context.database.db, actor.tenant.id).replaceForGeneration(
    generation.id,
    [
      {
        path: 'features/auth/login.feature',
        action: 'create',
        content: FEATURE,
        contentHash: 'seed-hash',
        scenarioCount: 1,
        validationStatus: 'valid',
        validationErrors: [],
      },
    ],
  );
}

describe('generation API', () => {
  it('creates an idempotent job, lists and exposes details', async () => {
    await withGenerationApp(async (context) => {
      const { actor, projectId } = await actorWithProject(context);
      const first = await createGeneration(context, actor, projectId);

      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as {
        created: boolean;
        generation: { id: string; status: string; mode: string; headSha: string };
      };
      expect(firstBody.created).toBe(true);
      expect(firstBody.generation).toMatchObject({ status: 'queued', mode: 'range' });

      const jobs = context.database.sqlite
        .prepare('SELECT type, status, payload_json, dedupe_key FROM jobs')
        .all() as Array<{
        type: string;
        status: string;
        payload_json: string;
        dedupe_key: string;
      }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        type: 'generation.run',
        status: 'queued',
        dedupe_key: `generation:${firstBody.generation.id}`,
      });
      expect(JSON.parse(jobs[0]?.payload_json ?? '{}')).toEqual({
        generationId: firstBody.generation.id,
      });

      const repeated = await createGeneration(context, actor, projectId);
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json() as { created: boolean; generation: { id: string } }).toMatchObject({
        created: false,
        generation: { id: firstBody.generation.id },
      });
      expect(context.database.sqlite.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({
        n: 1,
      });

      const list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/generations`,
        session: actor.session,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

      const detail = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/generations/${firstBody.generation.id}`,
        session: actor.session,
      });
      expect(detail.statusCode).toBe(200);
      expect((detail.json() as { generation: { files: unknown[] } }).generation.files).toEqual([]);

      const audit = context.database.sqlite
        .prepare("SELECT action FROM audit_logs WHERE action = 'generation.create'")
        .all();
      expect(audit).toHaveLength(1);
    });
  });

  it('validates input and enforces generation permissions', async () => {
    await withGenerationApp(async (context) => {
      const { actor, projectId } = await actorWithProject(context);
      const missingHead = await createGeneration(context, actor, projectId, { headSha: undefined });
      expect(missingHead.statusCode).toBe(400);

      const current = await createGeneration(context, actor, projectId, {
        mode: 'current',
        branch: 'main',
        baseSha: undefined,
        headSha: undefined,
      });
      expect(current.statusCode).toBe(201);

      const developer = await seedUser(context.database.db, {
        username: 'developer-user',
        tenantId: actor.tenant.id,
        role: 'developer',
      });
      expect(developer.id).toBeDefined();
      const developerSession = await login(context.app, 'developer-user', TEST_PASSWORD);
      expect(
        (
          await createGeneration(context, { ...actor, session: developerSession }, projectId, {
            headSha: 'c'.repeat(40),
          })
        ).statusCode,
      ).toBe(201);

      const viewer = await seedUser(context.database.db, {
        username: 'viewer-user',
        tenantId: actor.tenant.id,
        role: 'viewer',
      });
      expect(viewer.id).toBeDefined();
      const viewerSession = await login(context.app, 'viewer-user', TEST_PASSWORD);
      expect(
        (
          await createGeneration(context, { ...actor, session: viewerSession }, projectId, {
            headSha: 'd'.repeat(40),
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  it('edits, approves and commits a generation to the suite', async () => {
    await withGenerationApp(async (context, dataDir) => {
      const { actor, projectId } = await actorWithProject(context);
      seedAwaitingGeneration(context, actor, projectId, 'generation-approve');

      const editedContent = FEATURE.replace('login succeeds', 'login succeeds after edit');
      const edit = await authedRequest(context.app, {
        method: 'PATCH',
        url:
          '/api/v1/generations/generation-approve/files/' +
          (
            context.database.sqlite.prepare('SELECT id FROM generation_files LIMIT 1').get() as {
              id: string;
            }
          ).id,
        session: actor.session,
        payload: { content: editedContent },
      });
      expect(edit.statusCode).toBe(200);
      expect(
        (edit.json() as { generation: { approvalStatus: string } }).generation.approvalStatus,
      ).toBe('edited');

      const invalid = await authedRequest(context.app, {
        method: 'PATCH',
        url:
          '/api/v1/generations/generation-approve/files/' +
          (
            context.database.sqlite.prepare('SELECT id FROM generation_files LIMIT 1').get() as {
              id: string;
            }
          ).id,
        session: actor.session,
        payload: { content: 'Feature: Broken\n  Scenario: x\n    Given unknown step' },
      });
      expect(invalid.statusCode).toBe(400);

      const approved = await authedRequest(context.app, {
        method: 'POST',
        url: '/api/v1/generations/generation-approve/approve',
        session: actor.session,
        payload: { message: 'test(ai): approve generation' },
      });
      expect(approved.statusCode).toBe(200);
      const approvedBody = approved.json() as {
        generation: { status: string; files: Array<{ committedSha: string | null }> };
        commit: { commitSha: string; changed: boolean };
      };
      expect(approvedBody.generation.status).toBe('committed');
      expect(approvedBody.commit.changed).toBe(true);
      expect(approvedBody.generation.files[0]?.committedSha).toBe(approvedBody.commit.commitSha);

      const suiteRoot = join(dataDir, 'suites', projectId);
      const log = await runGit(['log', '-1', '--format=%B'], { cwd: suiteRoot });
      expect(log.stdout).toContain('test(ai): approve generation');
      expect(
        await new FeatureIndexRepository(context.database.db, actor.tenant.id).listActiveCases(
          projectId,
        ),
      ).toHaveLength(1);

      const audit = context.database.sqlite
        .prepare(
          "SELECT action FROM audit_logs WHERE action IN ('generation.edit','generation.commit')",
        )
        .all() as Array<{ action: string }>;
      expect(audit.map((row) => row.action)).toEqual(
        expect.arrayContaining(['generation.edit', 'generation.commit']),
      );

      const repeat = await authedRequest(context.app, {
        method: 'POST',
        url: '/api/v1/generations/generation-approve/approve',
        session: actor.session,
      });
      expect(repeat.statusCode).toBe(409);
    });
  });

  it('rejects generations and hides them from other tenants', async () => {
    await withGenerationApp(async (context) => {
      const alpha = await seedActor(context, {
        slug: 'alpha',
        username: 'alpha-owner',
        role: 'owner',
      });
      const beta = await seedActor(context, {
        slug: 'beta',
        username: 'beta-owner',
        role: 'owner',
      });
      const alphaProject = (
        (await createProject(context, alpha)).json() as {
          project: { id: string };
        }
      ).project.id;
      const betaProject = (
        (await createProject(context, beta)).json() as {
          project: { id: string };
        }
      ).project.id;
      seedAwaitingGeneration(context, alpha, alphaProject, 'generation-reject');

      const rejected = await authedRequest(context.app, {
        method: 'POST',
        url: '/api/v1/generations/generation-reject/reject',
        session: alpha.session,
        payload: { reason: 'not enough coverage' },
      });
      expect(rejected.statusCode).toBe(200);
      expect(
        rejected.json() as { generation: { status: string; approvalStatus: string } },
      ).toMatchObject({
        generation: { status: 'rejected', approvalStatus: 'rejected' },
      });

      for (const [method, url, payload] of [
        ['GET', '/api/v1/generations/generation-reject', undefined],
        ['POST', '/api/v1/generations/generation-reject/reject', { reason: 'hijack' }],
        ['POST', '/api/v1/generations/generation-reject/approve', undefined],
        ['GET', `/api/v1/projects/${alphaProject}/generations`, undefined],
        [
          'POST',
          `/api/v1/projects/${alphaProject}/generations`,
          { mode: 'range', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
        ],
      ] as const) {
        const response = await authedRequest(context.app, {
          method,
          url,
          session: beta.session,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }

      const betaList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${betaProject}/generations`,
        session: beta.session,
      });
      expect((betaList.json() as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
