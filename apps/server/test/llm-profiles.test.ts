// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequestOptions } from '../src/config/http-client.js';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import {
  createCredential,
  createLlmProfile,
  createProject,
  PUBLIC_DNS_LOOKUP,
  seedActor,
} from './config-helpers.js';

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

const LLM_SECRET = 'sk-llm-secret-123456';

async function projectWithKey(context: TestAppContext): Promise<{
  actor: Awaited<ReturnType<typeof seedActor>>;
  projectId: string;
  credentialId: string;
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
  const credentialId = (
    await createCredential(context, actor, projectId, {
      name: 'LLM Key',
      type: 'llm_api_key',
      secret: LLM_SECRET,
    })
  ).json() as { credential: { id: string } };

  return { actor, projectId, credentialId: credentialId.credential.id };
}

describe('llm profiles', () => {
  it('creates, lists, updates and deletes profiles with credential references', async () => {
    await withApp(async (context) => {
      const { actor, projectId, credentialId } = await projectWithKey(context);
      const created = await createLlmProfile(context, actor, projectId, {
        credentialId,
        params: { temperature: 0.2, jsonMode: true },
      });
      expect(created.statusCode).toBe(201);
      const profile = (
        created.json() as {
          profile: {
            id: string;
            credentialName: string;
            healthStatus: string;
            params: Record<string, unknown>;
          };
        }
      ).profile;
      expect(profile.credentialName).toBe('LLM Key');
      expect(profile.healthStatus).toBe('unknown');
      expect(profile.params).toEqual({ temperature: 0.2, jsonMode: true });
      expect(JSON.stringify(created.json())).not.toContain(LLM_SECRET);

      const duplicate = await createLlmProfile(context, actor, projectId, { credentialId });
      expect(duplicate.statusCode).toBe(400);

      const list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/llm-profiles`,
        session: actor.session,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

      const updated = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/llm-profiles/${profile.id}`,
        session: actor.session,
        payload: { model: 'gpt-test-v2', params: { temperature: 0.5 } },
      });
      expect(updated.statusCode).toBe(200);
      expect((updated.json() as { profile: { model: string } }).profile.model).toBe('gpt-test-v2');

      const removed = await authedRequest(context.app, {
        method: 'DELETE',
        url: `/api/v1/llm-profiles/${profile.id}`,
        session: actor.session,
      });
      expect(removed.statusCode).toBe(204);

      const audit = await authedRequest(context.app, {
        method: 'GET',
        url: '/api/v1/audit-logs?limit=100',
        session: actor.session,
      });
      const actions = (audit.json() as { items: Array<{ action: string }> }).items.map(
        (item) => item.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['llm_profile.create', 'llm_profile.update', 'llm_profile.delete']),
      );
    });
  });

  it('rejects wrong credential types, private URLs and missing permissions', async () => {
    await withApp(async (context) => {
      const { actor, projectId } = await projectWithKey(context);
      const gitCredential = (
        await createCredential(context, actor, projectId, {
          name: 'Git Only',
        })
      ).json() as { credential: { id: string } };

      const wrongType = await createLlmProfile(context, actor, projectId, {
        credentialId: gitCredential.credential.id,
      });
      expect(wrongType.statusCode).toBe(400);

      const privateUrl = await createLlmProfile(context, actor, projectId, {
        name: 'Private',
        baseUrl: 'http://127.0.0.1:8080/v1',
      });
      expect(privateUrl.statusCode).toBe(400);
      expect((privateUrl.json() as { code: string }).code).toBe('SSRF_BLOCKED');

      const developer = await seedUser(context.database.db, {
        username: 'developer-user',
        tenantId: actor.tenant.id,
        role: 'developer',
      });
      expect(developer.id).toBeDefined();
      const developerSession = await login(context.app, 'developer-user', TEST_PASSWORD);
      const deniedList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/llm-profiles`,
        session: developerSession,
      });
      expect(deniedList.statusCode).toBe(403);
      const deniedCreate = await createLlmProfile(
        context,
        { ...actor, session: developerSession },
        projectId,
        { name: 'Nope' },
      );
      expect(deniedCreate.statusCode).toBe(403);
    });
  });

  it('marks profiles healthy or unhealthy based on the provider response', async () => {
    const calls: HttpRequestOptions[] = [];
    const httpClient: HttpClient = async (options) => {
      calls.push(options);

      return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{}' };
    };
    await withApp(
      async (context) => {
        const { actor, projectId, credentialId } = await projectWithKey(context);
        const profile = (
          await createLlmProfile(context, actor, projectId, {
            credentialId,
            params: { timeoutMs: 2_000 },
          })
        ).json() as { profile: { id: string } };

        const tested = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${profile.profile.id}/test`,
          session: actor.session,
        });
        expect(tested.statusCode).toBe(200);
        expect(tested.json()).toMatchObject({ status: 'ok', code: 'OK' });
        expect(calls[0]?.url).toBe('https://llm.example.com/v1/models');
        expect(calls[0]?.headers?.authorization).toBe(`Bearer ${LLM_SECRET}`);
        expect(JSON.stringify(tested.json())).not.toContain(LLM_SECRET);

        const raw = (
          await context.database.pglite.query<{
            health_status: string;
            health_checked_at: number | null;
          }>('SELECT health_status, health_checked_at FROM llm_profiles WHERE id = $1', [
            profile.profile.id,
          ])
        ).rows[0];
        expect(raw?.health_status).toBe('healthy');
        expect(raw?.health_checked_at).not.toBeNull();

        // 修改连接参数后健康状态回到 unknown。
        const updated = await authedRequest(context.app, {
          method: 'PATCH',
          url: `/api/v1/llm-profiles/${profile.profile.id}`,
          session: actor.session,
          payload: { model: 'another-model' },
        });
        expect((updated.json() as { profile: { healthStatus: string } }).profile.healthStatus).toBe(
          'unknown',
        );

        const auditRows = (
          await context.database.pglite.query<{ detail_json: string }>(
            "SELECT detail_json FROM audit_logs WHERE action = 'llm_profile.test'",
          )
        ).rows;
        expect(auditRows.length).toBe(1);
        expect(auditRows[0]?.detail_json).not.toContain(LLM_SECRET);
      },
      { httpClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('uses provider-specific auth headers and reports HTTP failures', async () => {
    const calls: HttpRequestOptions[] = [];
    let nextStatus = 200;
    const httpClient: HttpClient = async (options) => {
      calls.push(options);

      return { status: nextStatus, headers: {}, bodyText: '' };
    };
    await withApp(
      async (context) => {
        const { actor, projectId, credentialId } = await projectWithKey(context);
        const anthropic = (
          await createLlmProfile(context, actor, projectId, {
            name: 'Claude',
            purpose: 'triage',
            provider: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-test',
            credentialId,
          })
        ).json() as { profile: { id: string } };

        const ok = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${anthropic.profile.id}/test`,
          session: actor.session,
        });
        expect(ok.statusCode).toBe(200);
        expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models');
        expect(calls[0]?.headers?.['x-api-key']).toBe(LLM_SECRET);
        expect(calls[0]?.headers?.['anthropic-version']).toBe('2023-06-01');

        nextStatus = 401;
        const denied = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${anthropic.profile.id}/test`,
          session: actor.session,
        });
        expect(denied.statusCode).toBe(200);
        expect(denied.json()).toMatchObject({ status: 'failed', code: 'AUTH_FAILED' });
        const healthy = (
          await context.database.pglite.query<{ health_status: string }>(
            'SELECT health_status FROM llm_profiles WHERE id = $1',
            [anthropic.profile.id],
          )
        ).rows[0];
        expect(healthy?.health_status).toBe('unhealthy');

        nextStatus = 200;
        const gemini = (
          await createLlmProfile(context, actor, projectId, {
            name: 'Gemini',
            purpose: 'vision',
            provider: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com',
            model: 'gemini-test',
            credentialId,
          })
        ).json() as { profile: { id: string } };
        const geminiTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${gemini.profile.id}/test`,
          session: actor.session,
        });
        expect(geminiTest.statusCode).toBe(200);
        const geminiCall = calls.at(-1);
        expect(geminiCall?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(geminiCall?.headers?.['x-goog-api-key']).toBe(LLM_SECRET);
      },
      { httpClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('blocks private DNS targets and reports network failures', async () => {
    let called = false;
    const httpClient: HttpClient = async () => {
      called = true;

      return { status: 200, headers: {}, bodyText: '' };
    };

    await withApp(
      async (context) => {
        const { actor, projectId } = await projectWithKey(context);
        const profile = (
          await createLlmProfile(context, actor, projectId, {
            name: 'Blocked',
          })
        ).json() as { profile: { id: string } };
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${profile.profile.id}/test`,
          session: actor.session,
        });
        expect(response.statusCode).toBe(400);
        expect((response.json() as { code: string }).code).toBe('SSRF_BLOCKED');
        expect(called).toBe(false);
      },
      {
        httpClient,
        dnsLookup: async () => [{ address: '10.0.0.8', family: 4 }],
      },
    );

    const failingClient: HttpClient = async () => {
      throw new Error('connection refused');
    };
    await withApp(
      async (context) => {
        const { actor, projectId } = await projectWithKey(context);
        const profile = (
          await createLlmProfile(context, actor, projectId, {
            name: 'Network',
          })
        ).json() as { profile: { id: string } };
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/llm-profiles/${profile.profile.id}/test`,
          session: actor.session,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'failed', code: 'NETWORK_ERROR' });
      },
      { httpClient: failingClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('hides foreign profiles behind 404', async () => {
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
      const profile = (await createLlmProfile(context, alpha, alphaProject)).json() as {
        profile: { id: string };
      };

      for (const [method, url, payload] of [
        ['GET', `/api/v1/projects/${alphaProject}/llm-profiles`, undefined],
        ['PATCH', `/api/v1/llm-profiles/${profile.profile.id}`, { name: 'Hijack' }],
        ['DELETE', `/api/v1/llm-profiles/${profile.profile.id}`, undefined],
        ['POST', `/api/v1/llm-profiles/${profile.profile.id}/test`, undefined],
      ] as const) {
        const response = await authedRequest(context.app, {
          method,
          url,
          session: beta.session,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }

      const ownList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${betaProject}/llm-profiles`,
        session: beta.session,
      });
      expect((ownList.json() as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
