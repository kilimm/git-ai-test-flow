// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { createEncryptionKey, SecretCipher } from '@gait/config';
import {
  CredentialRepository,
  EnvironmentRepository,
  ProjectRepository,
  RunRepository,
  TenantRepository,
} from '@gait/db';
import { UrlSafetyChecker } from '../src/config/ssrf.js';
import { CiService } from '../src/integrations/ci-service.js';
import {
  authedRequest,
  closeTestApp,
  cookieHeader,
  createTestApp,
  createTestEnv,
  login,
  mergeCookies,
  seedTenant,
  seedUser,
  TEST_ENCRYPTION_KEY,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import type { AuthContext } from '../src/auth/auth-service.js';
import type { HttpClient, HttpRequestOptions } from '../src/config/http-client.js';
import { AuditLogWriter } from '@gait/db';

const contexts: TestAppContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await closeTestApp(context);
  }
});

function fullEnvironment(projectId: string) {
  return {
    projectId,
    name: 'staging',
    apiBaseUrl: 'http://127.0.0.1:1',
    healthcheckExpectedStatus: 200,
    healthcheckTimeoutMs: 5_000,
    versionSource: 'manual' as const,
    strictVersionMatch: false,
    envVarsJson: '{}',
    browserJson: '{}',
    caseTimeoutMs: 30_000,
    apiConcurrency: 2,
    uiConcurrency: 1,
    isDefault: true,
  };
}

describe('quota API', () => {
  it('enforces concurrent run quota and exposes usage', async () => {
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
    const environment = await new EnvironmentRepository(context.database.db, tenant.id).create(
      fullEnvironment(project.id),
    );
    const session = await login(context.app, 'owner', TEST_PASSWORD);
    const quota = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/tenants/${tenant.id}/quota`,
      session,
    });

    expect(quota.statusCode).toBe(200);
    expect((quota.json() as { usage: { activeRuns: number } }).usage.activeRuns).toBe(0);

    const updated = await authedRequest(context.app, {
      method: 'PATCH',
      url: `/api/v1/tenants/${tenant.id}/quota`,
      session,
      payload: { maxConcurrentRuns: 1, maxRunsPerDay: 10 },
    });
    expect(updated.statusCode).toBe(200);

    const first = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${project.id}/runs`,
      session,
      payload: { environmentId: environment.id, headSha: 'a'.repeat(40) },
    });
    expect(first.statusCode).toBe(201);

    const blocked = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${project.id}/runs`,
      session,
      payload: { environmentId: environment.id, headSha: 'b'.repeat(40) },
    });

    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { code: string }).code).toBe('QUOTA_CONCURRENT_RUNS_EXCEEDED');
  });

  it('creates and lists environment groups', async () => {
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
    const session = await login(context.app, 'owner', TEST_PASSWORD);

    const created = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/projects/${project.id}/environment-groups`,
      session,
      payload: { name: 'staging-cn', description: 'CN region' },
    });
    expect(created.statusCode).toBe(201);

    const list = await authedRequest(context.app, {
      method: 'GET',
      url: `/api/v1/projects/${project.id}/environment-groups`,
      session,
    });
    const items = (list.json() as { items: Array<{ name: string }> }).items;

    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('staging-cn');
  });
});

describe('CI integration', () => {
  it('tests repository access and publishes a run report comment', async () => {
    const env = createTestEnv();
    const app = await createTestApp();
    contexts.push(app);
    const tenant = await new TenantRepository(app.database.db).create({
      slug: 'acme',
      name: 'Acme',
    });
    const user = await seedUser(app.database.db, {
      username: 'owner',
      tenantId: tenant.id,
      role: 'owner',
    });
    const project = await new ProjectRepository(app.database.db, tenant.id).create({
      name: 'Demo',
      slug: 'demo',
      productRepoUrl: 'https://example.com/demo.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });
    const cipher = new SecretCipher(createEncryptionKey(TEST_ENCRYPTION_KEY));
    const encrypted = cipher.encrypt(tenant.id, 'ci-cred', 'git_pat', 'ci-token-value');
    const credential = await new CredentialRepository(app.database.db, tenant.id).create({
      id: 'ci-cred',
      name: 'ci',
      type: 'git_pat',
      secret: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
      },
    });
    const run = await new RunRepository(app.database.db, tenant.id).create({
      projectId: project.id,
      headSha: 'e'.repeat(40),
      status: 'failed',
      idempotencyKey: 'ci-run',
      statsJson: JSON.stringify({ total: 1, passed: 0, failed: 1 }),
    });
    const requests: HttpRequestOptions[] = [];
    const httpClient: HttpClient = async (options) => {
      requests.push(options);

      return { status: options.method === 'POST' ? 201 : 200, headers: {}, bodyText: '{}' };
    };
    const service = new CiService({
      db: app.database.db,
      deps: {
        auditWriter: new AuditLogWriter(app.database.db),
        cipher,
        urlSafety: new UrlSafetyChecker({
          allowlist: ['api.github.com'],
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        }),
        httpClient,
        gitLsRemote: async () => ({
          ok: true,
          code: 'OK',
          message: 'ok',
          durationMs: 0,
        }),
        now: () => Date.now(),
      },
      cipher,
      auditWriter: new AuditLogWriter(app.database.db),
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
    const context = {
      user,
      tenant,
      session: {} as AuthContext['session'],
      role: 'owner' as const,
      permissions: [],
    } satisfies AuthContext;
    const integration = await service.upsert(context, project.id, {
      name: 'github',
      provider: 'github',
      repository: 'acme/demo',
      tokenCredentialId: credential.id,
    });
    const otherProject = await new ProjectRepository(app.database.db, tenant.id).create({
      name: 'Other',
      slug: 'other',
      productRepoUrl: 'https://example.com/other.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });

    // 路径项目与集成所属项目不一致时按不存在处理，防止借项目 A 的路径操作项目 B 的集成。
    await expect(service.test(context, otherProject.id, integration.id)).rejects.toThrow(
      'CI integration not found',
    );

    const testResult = await service.test(context, project.id, integration.id);

    expect(testResult.status).toBe('ok');
    expect(requests[0]?.headers?.['authorization']).toBe('Bearer ci-token-value');

    const published = await service.publish(context, {
      projectId: project.id,
      integrationId: integration.id,
      runId: run.id,
      pullRequestNumber: 42,
    });

    expect(published.status).toBe('ok');
    expect(published.responseStatus).toBe(201);
    expect(requests[1]?.url).toContain('/issues/42/comments');
    expect(requests[1]?.body).toContain('测试报告');
  });
});

describe('runner registry', () => {
  it('registers a runner, accepts token-authenticated heartbeat and lists online nodes', async () => {
    const context = await createTestApp();
    contexts.push(context);
    const tenant = await seedTenant(context.database.db);
    await seedUser(context.database.db, {
      username: 'platform',
      tenantId: tenant.id,
      role: 'owner',
      isPlatformAdmin: true,
    });
    const session = await login(context.app, 'platform', TEST_PASSWORD);
    const created = await authedRequest(context.app, {
      method: 'POST',
      url: '/api/v1/runners',
      session,
      payload: { name: 'runner-a', capacity: 2 },
    });
    const body = created.json() as { token: string; runner: { id: string } };

    expect(created.statusCode).toBe(201);
    expect(body.token).toMatch(/^gait_run_/);

    const heartbeat = await context.app.inject({
      method: 'POST',
      url: '/runner-heartbeat',
      headers: { authorization: `Bearer ${body.token}` },
      payload: { name: 'runner-a', version: '0.3.0' },
    });

    expect(heartbeat.statusCode).toBe(200);

    const list = await authedRequest(context.app, {
      method: 'GET',
      url: '/api/v1/runners',
      session,
    });
    const items = (list.json() as { items: Array<{ status: string; version: string }> }).items;

    expect(items[0]?.status).toBe('online');
    expect(items[0]?.version).toBe('0.3.0');
  });
});

describe('SSO OIDC', () => {
  it('creates provider, starts authorization and provisions user on callback', async () => {
    const requests: HttpRequestOptions[] = [];
    const httpClient: HttpClient = async (options) => {
      requests.push(options);

      if (options.url.includes('/token')) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ access_token: 'access-token' }),
        };
      }

      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          sub: 'subject-1',
          email: 'sso.user@example.com',
          name: 'SSO User',
        }),
      };
    };
    const context = await createTestApp({
      envOverrides: { SSRF_ALLOWLIST: 'idp.example.com' },
      httpClient,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    contexts.push(context);
    const tenant = await seedTenant(context.database.db);
    await seedUser(context.database.db, {
      username: 'owner',
      tenantId: tenant.id,
      role: 'owner',
    });
    const owner = await login(context.app, 'owner', TEST_PASSWORD);
    const created = await authedRequest(context.app, {
      method: 'POST',
      url: `/api/v1/tenants/${tenant.id}/sso-providers`,
      session: owner,
      payload: {
        name: 'Example SSO',
        issuer: 'https://idp.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        userinfoEndpoint: 'https://idp.example.com/userinfo',
        allowedEmailDomains: ['example.com'],
        defaultRole: 'developer',
      },
    });
    const provider = (created.json() as { provider: { id: string } }).provider;

    expect(created.statusCode).toBe(201);

    const publicList = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/acme/providers',
    });
    expect((publicList.json() as { items: unknown[] }).items).toHaveLength(1);

    const start = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/sso/${provider.id}/start?redirect=/projects`,
    });

    expect(start.statusCode).toBe(302);
    const location = new URL(String(start.headers.location));
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();
    const startCookies = mergeCookies(start);
    const stateCookie = startCookies.get('gait_sso_state');

    expect(stateCookie).toBeTruthy();

    const callback = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/sso/${provider.id}/callback?code=code-1&state=${encodeURIComponent(
        state ?? '',
      )}`,
      headers: { cookie: cookieHeader(startCookies) },
    });

    expect(callback.statusCode).toBe(302);
    const callbackCookies = mergeCookies(callback, new Map(startCookies));
    const me = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(callbackCookies) },
    });

    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe('sso.user@example.com');
    expect(
      requests.some((request) => request.url.includes('/token') && request.method === 'POST'),
    ).toBe(true);
  });
});
