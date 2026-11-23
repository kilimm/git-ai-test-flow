// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { TenantRepository } from '@gait/db';
import type { GitLsRemoteInput } from '../src/config/git-client.js';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import { createCredential, createProject, seedActor } from './config-helpers.js';
import type { SeededActor } from './config-helpers.js';

async function withApp(
  run: (context: TestAppContext) => Promise<void>,
  options: Parameters<typeof createTestApp>[0] = {},
): Promise<void> {
  const context = await createTestApp(options);

  try {
    await run(context);
  } finally {
    await closeTestApp(context);
  }
}

function errorCode(body: unknown): string {
  return (body as { code: string }).code;
}

describe('projects', () => {
  it('creates, lists, updates and deletes a project with suite defaults', async () => {
    await withApp(async (context) => {
      const actor = await seedActor(context, {
        slug: 'acme',
        username: 'owner',
        role: 'owner',
      });

      const created = await createProject(context, actor, { suiteMode: 'same_repo' });
      expect(created.statusCode).toBe(201);
      const project = (created.json() as { project: Record<string, unknown> }).project;
      expect(project.suiteMode).toBe('same_repo');
      expect(project.suitePath).toBe('.ai-test/');
      expect(project.featureRoot).toBe('features/');
      expect(project.docsRoot).toBe('docs/ai/');
      expect(project.settings).toEqual({});
      expect(project.gitCredentialId).toBeNull();

      const list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/tenants/${actor.tenant.id}/projects`,
        session: actor.session,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

      const projectId = project.id as string;
      const detail = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
      });
      expect(detail.statusCode).toBe(200);

      const updated = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
        payload: { name: 'Renamed', suiteMode: 'managed', settings: { concurrency: 2 } },
      });
      expect(updated.statusCode).toBe(200);
      const updatedProject = (updated.json() as { project: Record<string, unknown> }).project;
      expect(updatedProject.name).toBe('Renamed');
      expect(updatedProject.suitePath).toBeNull();
      expect(updatedProject.suiteRepoUrl).toBeNull();
      expect(updatedProject.settings).toEqual({ concurrency: 2 });

      const removed = await authedRequest(context.app, {
        method: 'DELETE',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
      });
      expect(removed.statusCode).toBe(204);

      const missing = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
      });
      expect(missing.statusCode).toBe(404);

      const audit = await authedRequest(context.app, {
        method: 'GET',
        url: '/api/v1/audit-logs?limit=100',
        session: actor.session,
      });
      const actions = (audit.json() as { items: Array<{ action: string }> }).items.map(
        (item) => item.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['project.create', 'project.update', 'project.delete']),
      );
      const rows = (
        await context.database.pglite.query<{ tenant_id: string | null }>(
          "SELECT tenant_id FROM audit_logs WHERE action LIKE 'project.%'",
        )
      ).rows;
      expect(rows.every((row) => row.tenant_id === actor.tenant.id)).toBe(true);
    });
  });

  it('validates suite mode combinations, paths, branches and unique slugs per tenant', async () => {
    await withApp(async (context) => {
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

      const first = await createProject(context, alpha);
      expect(first.statusCode).toBe(201);
      const duplicate = await createProject(context, alpha, { name: 'Another' });
      expect(duplicate.statusCode).toBe(400);
      expect(errorCode(duplicate.json())).toBe('VALIDATION_ERROR');

      const externalMissing = await createProject(context, alpha, {
        name: 'External',
        slug: 'external',
        suiteMode: 'external',
      });
      expect(externalMissing.statusCode).toBe(400);

      const managedWithRepo = await createProject(context, alpha, {
        name: 'Managed',
        slug: 'managed-repo',
        suiteMode: 'managed',
        suiteRepoUrl: 'https://github.com/acme/suite.git',
      });
      expect(managedWithRepo.statusCode).toBe(400);

      const badPath = await createProject(context, alpha, {
        name: 'Bad Path',
        slug: 'bad-path',
        suiteMode: 'same_repo',
        suitePath: '../escape',
      });
      expect(badPath.statusCode).toBe(400);

      const badBranch = await createProject(context, alpha, {
        name: 'Bad Branch',
        slug: 'bad-branch',
        defaultBranch: 'bad branch',
      });
      expect(badBranch.statusCode).toBe(400);

      const badUrl = await createProject(context, alpha, {
        name: 'Bad URL',
        slug: 'bad-url',
        productRepoUrl: 'ftp://example.com/repo.git',
      });
      expect(badUrl.statusCode).toBe(400);

      const projectId = (first.json() as { project: { id: string } }).project.id;
      expect(
        (
          await authedRequest(context.app, {
            method: 'PATCH',
            url: `/api/v1/projects/${projectId}`,
            session: alpha.session,
            payload: { suiteRepoUrl: 'https://github.com/acme/suite.git' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await authedRequest(context.app, {
            method: 'PATCH',
            url: `/api/v1/projects/${projectId}`,
            session: alpha.session,
            payload: { suitePath: 'custom-suite' },
          })
        ).statusCode,
      ).toBe(400);

      // slug 只在租户内唯一，不同租户可以相同。
      const betaProject = await createProject(context, beta);
      expect(betaProject.statusCode).toBe(201);
    });
  });

  it('rejects cross-tenant credentials and wrong credential types', async () => {
    await withApp(async (context) => {
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
      const betaProject = (await createProject(context, beta)).json() as {
        project: { id: string };
      };
      const betaCredential = (
        await createCredential(context, beta, betaProject.project.id)
      ).json() as { credential: { id: string } };

      const crossTenant = await createProject(context, alpha, {
        slug: 'cross',
        name: 'Cross',
        gitCredentialId: betaCredential.credential.id,
      });
      expect(crossTenant.statusCode).toBe(400);

      const alphaProject = (await createProject(context, alpha)).json() as {
        project: { id: string };
      };
      const llmCredential = (
        await createCredential(context, alpha, alphaProject.project.id, {
          name: 'LLM key',
          type: 'llm_api_key',
          secret: 'sk-test-key-123456',
        })
      ).json() as { credential: { id: string } };

      const wrongType = await createProject(context, alpha, {
        slug: 'wrong-type',
        name: 'Wrong Type',
        gitCredentialId: llmCredential.credential.id,
      });
      expect(wrongType.statusCode).toBe(400);
    });
  });

  it('enforces project permissions for developer, viewer, admin and owner', async () => {
    await withApp(async (context) => {
      const owner = await seedActor(context, {
        slug: 'acme',
        username: 'owner',
        role: 'owner',
      });
      const admin = await seedActorInTenant(context, owner.tenant.id, 'admin-user', 'admin');
      const developer = await seedActorInTenant(
        context,
        owner.tenant.id,
        'developer-user',
        'developer',
      );
      const viewer = await seedActorInTenant(context, owner.tenant.id, 'viewer-user', 'viewer');

      const createdByAdmin = await createProject(context, admin, {
        slug: 'admin-project',
        name: 'Admin Project',
      });
      expect(createdByAdmin.statusCode).toBe(201);
      const projectId = (createdByAdmin.json() as { project: { id: string } }).project.id;

      expect((await createProject(context, developer)).statusCode).toBe(403);
      expect((await createProject(context, viewer)).statusCode).toBe(403);
      expect(
        (
          await authedRequest(context.app, {
            method: 'PATCH',
            url: `/api/v1/projects/${projectId}`,
            session: developer.session,
            payload: { name: 'Nope' },
          })
        ).statusCode,
      ).toBe(403);

      const developerRead = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/tenants/${owner.tenant.id}/projects`,
        session: developer.session,
      });
      expect(developerRead.statusCode).toBe(200);
      expect(
        (
          await authedRequest(context.app, {
            method: 'GET',
            url: `/api/v1/projects/${projectId}`,
            session: viewer.session,
          })
        ).statusCode,
      ).toBe(200);

      // 只有 OWNER 拥有 project:delete。
      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/projects/${projectId}`,
            session: admin.session,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/projects/${projectId}`,
            session: owner.session,
          })
        ).statusCode,
      ).toBe(204);
    });
  });

  it('hides foreign projects behind 404 for every verb and nested resource', async () => {
    await withApp(async (context) => {
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
      const projectId = (
        (await createProject(context, alpha)).json() as {
          project: { id: string };
        }
      ).project.id;

      for (const [method, url, payload] of [
        ['GET', `/api/v1/projects/${projectId}`, undefined],
        ['PATCH', `/api/v1/projects/${projectId}`, { name: 'Hijack' }],
        ['DELETE', `/api/v1/projects/${projectId}`, undefined],
        ['GET', `/api/v1/projects/${projectId}/credentials`, undefined],
        ['GET', `/api/v1/projects/${projectId}/llm-profiles`, undefined],
        ['GET', `/api/v1/projects/${projectId}/environments`, undefined],
        ['GET', `/api/v1/projects/${projectId}/notification-channels`, undefined],
        ['GET', `/api/v1/tenants/${alpha.tenant.id}/projects`, undefined],
      ] as const) {
        const response = await authedRequest(context.app, {
          method,
          url,
          session: beta.session,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
        expect(errorCode(response.json())).toBe('NOT_FOUND');
      }

      const betaList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/tenants/${beta.tenant.id}/projects`,
        session: beta.session,
      });
      expect((betaList.json() as { items: unknown[] }).items).toHaveLength(0);
    });
  });

  it('tests Git connectivity with and without credentials without leaking the token', async () => {
    const calls: GitLsRemoteInput[] = [];
    await withApp(
      async (context) => {
        const actor = await seedActor(context, {
          slug: 'acme',
          username: 'owner',
          role: 'owner',
        });
        const project = (await createProject(context, actor)).json() as {
          project: { id: string };
        };
        const projectId = project.project.id;

        const publicResult = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/projects/${projectId}/test-connection`,
          session: actor.session,
        });
        expect(publicResult.statusCode).toBe(200);
        expect((publicResult.json() as { status: string }).status).toBe('ok');
        expect(calls[0]?.token).toBeUndefined();

        const credential = (await createCredential(context, actor, projectId)).json() as {
          credential: { id: string };
        };

        await authedRequest(context.app, {
          method: 'PATCH',
          url: `/api/v1/projects/${projectId}`,
          session: actor.session,
          payload: { gitCredentialId: credential.credential.id },
        });

        const authedResult = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/projects/${projectId}/test-connection`,
          session: actor.session,
        });
        const body = authedResult.json() as { status: string; message: string };
        expect(authedResult.statusCode).toBe(200);
        expect(body.status).toBe('ok');
        expect(calls[1]?.token).toBe('ghp_sample_token_123456');
        expect(calls[1]?.repoUrl).toBe('https://github.com/acme/demo.git');
        expect(JSON.stringify(body)).not.toContain('ghp_sample_token_123456');

        const auditRows = (
          await context.database.pglite.query<{ detail_json: string }>(
            "SELECT detail_json FROM audit_logs WHERE action = 'project.test_connection'",
          )
        ).rows;
        expect(auditRows.length).toBe(2);
        expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(
          'ghp_sample_token_123456',
        );
      },
      {
        gitLsRemote: async (input) => {
          calls.push(input);

          return {
            ok: true,
            code: 'OK',
            message: 'Git connection succeeded (1 branches)',
            durationMs: 3,
          };
        },
      },
    );
  });

  it('returns a failed connectivity result for Git authentication errors', async () => {
    await withApp(
      async (context) => {
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
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/projects/${projectId}/test-connection`,
          session: actor.session,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: 'failed',
          code: 'AUTH_FAILED',
        });
      },
      {
        gitLsRemote: async () => ({
          ok: false,
          code: 'AUTH_FAILED',
          message: 'Authentication failed',
          durationMs: 5,
        }),
      },
    );
  });
});

async function seedActorInTenant(
  context: TestAppContext,
  tenantId: string,
  username: string,
  role: 'admin' | 'developer' | 'viewer',
): Promise<SeededActor> {
  const user = await seedUser(context.database.db, {
    username,
    tenantId,
    role,
  });
  const tenant = await new TenantRepository(context.database.db).findById(tenantId);

  if (tenant === undefined) {
    throw new Error('Tenant missing in test setup');
  }

  const session = await login(context.app, username, TEST_PASSWORD);

  return { tenant, user, session };
}
