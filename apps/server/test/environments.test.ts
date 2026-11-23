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
  createEnvironment,
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

async function projectActor(context: TestAppContext): Promise<{
  actor: Awaited<ReturnType<typeof seedActor>>;
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

function dbConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'mysql',
    host: 'db.example.com',
    port: 3306,
    name: 'app_test',
    user: 'tester',
    isTest: true,
    writeMode: 'readonly',
    ...overrides,
  };
}

describe('environments', () => {
  it('creates environments, enforces a single default and updates partial versions', async () => {
    await withApp(async (context) => {
      const { actor, projectId } = await projectActor(context);
      const first = await createEnvironment(context, actor, projectId, { name: 'staging' });
      expect(first.statusCode).toBe(201);
      const firstEnvironment = (
        first.json() as {
          environment: {
            id: string;
            version: { source: string; deployedSha: string | null };
            healthStatus: string;
            db: unknown;
            isDefault: boolean;
          };
        }
      ).environment;
      expect(firstEnvironment.version).toMatchObject({
        source: 'manual',
        deployedSha: null,
      });
      expect(firstEnvironment.healthStatus).toBe('unknown');
      expect(firstEnvironment.db).toBeNull();

      const second = await createEnvironment(context, actor, projectId, {
        name: 'preprod',
        isDefault: true,
      });
      expect(second.statusCode).toBe(201);
      const secondEnvironment = (
        second.json() as {
          environment: { id: string };
        }
      ).environment;

      let list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/environments`,
        session: actor.session,
      });
      let items = (
        list.json() as {
          items: Array<{ id: string; isDefault: boolean }>;
        }
      ).items;
      expect(items.find((item) => item.id === firstEnvironment.id)?.isDefault).toBe(false);
      expect(items.find((item) => item.id === secondEnvironment.id)?.isDefault).toBe(true);

      const updated = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/environments/${secondEnvironment.id}`,
        session: actor.session,
        payload: { name: 'preprod-2', version: { deployedSha: 'abc1234' } },
      });
      expect(updated.statusCode).toBe(200);
      expect(
        (
          updated.json() as {
            environment: { name: string; version: { deployedSha: string } };
          }
        ).environment,
      ).toMatchObject({ name: 'preprod-2', version: { deployedSha: 'abc1234' } });

      const promoted = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/environments/${firstEnvironment.id}`,
        session: actor.session,
        payload: { isDefault: true },
      });
      expect(promoted.statusCode).toBe(200);

      list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/environments`,
        session: actor.session,
      });
      items = (list.json() as { items: Array<{ id: string; isDefault: boolean }> }).items;
      expect(items.find((item) => item.id === firstEnvironment.id)?.isDefault).toBe(true);
      expect(items.find((item) => item.id === secondEnvironment.id)?.isDefault).toBe(false);

      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/environments/${secondEnvironment.id}`,
            session: actor.session,
          })
        ).statusCode,
      ).toBe(204);

      const audit = await authedRequest(context.app, {
        method: 'GET',
        url: '/api/v1/audit-logs?limit=100',
        session: actor.session,
      });
      const actions = (audit.json() as { items: Array<{ action: string }> }).items.map(
        (item) => item.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['environment.create', 'environment.update', 'environment.delete']),
      );
    });
  });

  it('rejects production databases, unconfirmed writes, sensitive env vars and bad versions', async () => {
    await withApp(async (context) => {
      const { actor, projectId } = await projectActor(context);

      const production = await createEnvironment(context, actor, projectId, {
        name: 'prod-db',
        db: dbConfig({ isTest: false }),
      });
      expect(production.statusCode).toBe(400);
      expect((production.json() as { code: string }).code).toBe('PRODUCTION_DATABASE_FORBIDDEN');

      const unconfirmed = await createEnvironment(context, actor, projectId, {
        name: 'write-db',
        db: dbConfig({ writeMode: 'fixtures' }),
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect((unconfirmed.json() as { code: string }).code).toBe(
        'DANGEROUS_OPERATION_CONFIRMATION_REQUIRED',
      );

      const confirmed = await createEnvironment(context, actor, projectId, {
        name: 'write-db-confirmed',
        db: dbConfig({ writeMode: 'fixtures' }),
        confirmDangerous: true,
      });
      expect(confirmed.statusCode).toBe(201);
      expect(
        (confirmed.json() as { environment: { db: { writeMode: string } } }).environment.db
          .writeMode,
      ).toBe('fixtures');

      const sensitive = await createEnvironment(context, actor, projectId, {
        name: 'sensitive-vars',
        envVars: { DB_PASSWORD: 'should-not-be-here' },
      });
      expect(sensitive.statusCode).toBe(400);
      expect((sensitive.json() as { code: string }).code).toBe('SENSITIVE_ENV_VAR_FORBIDDEN');

      const missingEndpoint = await createEnvironment(context, actor, projectId, {
        name: 'version-endpoint-missing',
        version: { source: 'endpoint' },
      });
      expect(missingEndpoint.statusCode).toBe(400);

      const missingHeader = await createEnvironment(context, actor, projectId, {
        name: 'version-header-missing',
        version: { source: 'header' },
      });
      expect(missingHeader.statusCode).toBe(400);

      const badJsonPath = await createEnvironment(context, actor, projectId, {
        name: 'version-json-path',
        version: {
          source: 'endpoint',
          endpoint: 'https://api.example.com/version',
          jsonPath: 'data..sha',
        },
      });
      expect(badJsonPath.statusCode).toBe(400);

      const privateUrl = await createEnvironment(context, actor, projectId, {
        name: 'private',
        apiBaseUrl: 'http://127.0.0.1:8080',
      });
      expect(privateUrl.statusCode).toBe(400);
      expect((privateUrl.json() as { code: string }).code).toBe('SSRF_BLOCKED');

      const badScript = await createEnvironment(context, actor, projectId, {
        name: 'bad-script',
        setupScript: '../setup.sh',
      });
      expect(badScript.statusCode).toBe(400);

      const gitCredential = (await createCredential(context, actor, projectId)).json() as {
        credential: { id: string };
      };
      const wrongTestAccount = await createEnvironment(context, actor, projectId, {
        name: 'wrong-test-account',
        testAccountCredentialId: gitCredential.credential.id,
      });
      expect(wrongTestAccount.statusCode).toBe(400);

      const wrongDbCredential = await createEnvironment(context, actor, projectId, {
        name: 'wrong-db-credential',
        db: dbConfig({ credentialId: gitCredential.credential.id }),
      });
      expect(wrongDbCredential.statusCode).toBe(400);
    });
  });

  it('runs healthchecks and resolves versions from headers and JSON endpoints', async () => {
    const calls: HttpRequestOptions[] = [];
    const httpClient: HttpClient = async (options) => {
      calls.push(options);

      if (options.url.endsWith('/version')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({ data: { deploy: { sha: 'endpoint-sha-001' } } }),
        };
      }

      return {
        status: 200,
        headers: { 'x-deployed-sha': 'header-sha-002' },
        bodyText: 'ok',
      };
    };
    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const headerEnvironment = (
          await createEnvironment(context, actor, projectId, {
            name: 'header-version',
            healthcheck: {
              url: 'https://api.example.com/health',
              expectedStatus: 200,
              timeoutMs: 2_000,
            },
            version: { source: 'header', header: 'X-Deployed-Sha' },
          })
        ).json() as { environment: { id: string } };

        const headerTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${headerEnvironment.environment.id}/test`,
          session: actor.session,
        });
        expect(headerTest.statusCode).toBe(200);
        expect(headerTest.json()).toMatchObject({
          status: 'ok',
          healthcheck: { status: 'ok' },
          version: { status: 'ok', sha: 'header-sha-002' },
          deployedSha: 'header-sha-002',
        });

        const endpointCreated = await createEnvironment(context, actor, projectId, {
          name: 'endpoint-version',
          healthcheck: {
            url: 'https://api.example.com/health',
            expectedStatus: 200,
            timeoutMs: 2_000,
          },
          version: {
            source: 'endpoint',
            endpoint: 'https://api.example.com/version',
            jsonPath: 'data.deploy.sha',
          },
        });
        expect(endpointCreated.statusCode).toBe(201);
        const endpointEnvironment = endpointCreated.json() as { environment: { id: string } };

        const endpointTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${endpointEnvironment.environment.id}/test`,
          session: actor.session,
        });
        expect(endpointTest.statusCode).toBe(200);
        expect(endpointTest.json()).toMatchObject({
          status: 'ok',
          version: { status: 'ok', sha: 'endpoint-sha-001' },
          deployedSha: 'endpoint-sha-001',
        });

        const stored = (
          await context.database.pglite.query<{
            health_status: string;
            deployed_sha: string;
          }>('SELECT health_status, deployed_sha FROM environments WHERE id = $1', [
            headerEnvironment.environment.id,
          ])
        ).rows[0];
        expect(stored?.health_status).toBe('healthy');
        expect(stored?.deployed_sha).toBe('header-sha-002');

        const fallbackEnvironment = (
          await createEnvironment(context, actor, projectId, {
            name: 'header-fallback',
            version: { source: 'header', header: 'X-Deployed-Sha' },
          })
        ).json() as { environment: { id: string } };
        const fallbackTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${fallbackEnvironment.environment.id}/test`,
          session: actor.session,
        });
        expect(fallbackTest.statusCode).toBe(200);
        expect(fallbackTest.json()).toMatchObject({
          status: 'ok',
          healthcheck: { status: 'skipped' },
          version: { status: 'ok', sha: 'header-sha-002' },
        });

        const manualEnvironment = (
          await createEnvironment(context, actor, projectId, {
            name: 'manual-only',
            version: { source: 'manual', deployedSha: 'manual-sha-999' },
          })
        ).json() as { environment: { id: string } };
        const manualTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${manualEnvironment.environment.id}/test`,
          session: actor.session,
        });
        expect(manualTest.json()).toMatchObject({
          status: 'ok',
          healthcheck: { status: 'skipped' },
          version: { status: 'manual', sha: 'manual-sha-999' },
          deployedSha: 'manual-sha-999',
        });

        const mismatch = (
          await createEnvironment(context, actor, projectId, {
            name: 'status-mismatch',
            healthcheck: {
              url: 'https://api.example.com/health',
              expectedStatus: 201,
              timeoutMs: 2_000,
            },
          })
        ).json() as { environment: { id: string } };
        const mismatchTest = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${mismatch.environment.id}/test`,
          session: actor.session,
        });
        expect(mismatchTest.statusCode).toBe(200);
        expect(mismatchTest.json()).toMatchObject({
          status: 'failed',
          healthcheck: { status: 'failed', code: 'HEALTHCHECK_STATUS_MISMATCH' },
          version: { status: 'skipped', code: 'HEALTHCHECK_FAILED' },
        });

        const auditRows = (
          await context.database.pglite.query<{ detail_json: string }>(
            "SELECT detail_json FROM audit_logs WHERE action = 'environment.test'",
          )
        ).rows;
        expect(auditRows.length).toBe(5);

        // 环境测试需要 environment:write；开发者不能触发外部请求。
        const developer = await seedUser(context.database.db, {
          username: 'developer-user',
          tenantId: actor.tenant.id,
          role: 'developer',
        });
        expect(developer.id).toBeDefined();
        const developerSession = await login(context.app, 'developer-user', TEST_PASSWORD);
        expect(
          (
            await authedRequest(context.app, {
              method: 'POST',
              url: `/api/v1/environments/${headerEnvironment.environment.id}/test`,
              session: developerSession,
            })
          ).statusCode,
        ).toBe(403);
      },
      { httpClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('reports network failures and blocks private DNS results before requesting', async () => {
    let called = false;
    const httpClient: HttpClient = async () => {
      called = true;

      return { status: 200, headers: {}, bodyText: 'ok' };
    };

    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const environment = (
          await createEnvironment(context, actor, projectId, {
            name: 'private-dns',
            healthcheck: {
              url: 'https://internal.example.com/health',
              expectedStatus: 200,
              timeoutMs: 2_000,
            },
          })
        ).json() as { environment: { id: string } };
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${environment.environment.id}/test`,
          session: actor.session,
        });
        expect(response.statusCode).toBe(400);
        expect((response.json() as { code: string }).code).toBe('SSRF_BLOCKED');
        expect(called).toBe(false);
      },
      {
        httpClient,
        dnsLookup: async () => [{ address: '192.168.10.20', family: 4 }],
      },
    );

    const failingClient: HttpClient = async () => {
      throw new Error('connection refused');
    };
    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const environment = (
          await createEnvironment(context, actor, projectId, {
            name: 'network-down',
            healthcheck: {
              url: 'https://api.example.com/health',
              expectedStatus: 200,
              timeoutMs: 2_000,
            },
          })
        ).json() as { environment: { id: string } };
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/environments/${environment.environment.id}/test`,
          session: actor.session,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: 'failed',
          healthcheck: { status: 'failed', code: 'NETWORK_ERROR' },
        });
      },
      { httpClient: failingClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('hides foreign environments behind 404', async () => {
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
      const environment = (await createEnvironment(context, alpha, alphaProject)).json() as {
        environment: { id: string };
      };

      for (const [method, url, payload] of [
        ['GET', `/api/v1/projects/${alphaProject}/environments`, undefined],
        ['PATCH', `/api/v1/environments/${environment.environment.id}`, { name: 'Hijack' }],
        ['DELETE', `/api/v1/environments/${environment.environment.id}`, undefined],
        ['POST', `/api/v1/environments/${environment.environment.id}/test`, undefined],
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
        url: `/api/v1/projects/${betaProject}/environments`,
        session: beta.session,
      });
      expect((ownList.json() as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
