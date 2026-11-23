// 本文件所有改动要求遵循 agent-rules 规范
import type { LightMyRequestResponse } from 'fastify';
import type { Tenant, User } from '@gait/db';
import type { TenantRole } from '@gait/shared';
import type { DnsLookup } from '../src/config/ssrf.js';
import { authedRequest, login, seedTenant, seedUser, TEST_PASSWORD } from './helpers.js';
import type { LoginResult, TestAppContext } from './helpers.js';

export interface SeededActor {
  tenant: Tenant;
  user: User;
  session: LoginResult;
}

export async function seedActor(
  context: TestAppContext,
  options: { slug: string; username: string; role: TenantRole },
): Promise<SeededActor> {
  const tenant = await seedTenant(context.database.db, options.slug);
  const user = await seedUser(context.database.db, {
    username: options.username,
    tenantId: tenant.id,
    role: options.role,
  });
  const session = await login(context.app, options.username, TEST_PASSWORD);

  return { tenant, user, session };
}

/** 默认把所有域名解析到公网地址，测试中不会真正访问 DNS。 */
export const PUBLIC_DNS_LOOKUP: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

export const PROJECT_PAYLOAD = {
  name: 'Demo Project',
  slug: 'demo',
  productRepoUrl: 'https://github.com/acme/demo.git',
  defaultBranch: 'main',
  suiteMode: 'managed',
} as const;

export function createProject(
  context: TestAppContext,
  actor: SeededActor,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/tenants/${actor.tenant.id}/projects`,
    session: actor.session,
    payload: { ...PROJECT_PAYLOAD, ...overrides },
  });
}

export function createCredential(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    session: actor.session,
    payload: {
      name: 'Git Token',
      type: 'git_pat',
      username: 'x-access-token',
      secret: 'ghp_sample_token_123456',
      ...overrides,
    },
  });
}

export function createLlmProfile(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/llm-profiles`,
    session: actor.session,
    payload: {
      name: 'Generation Model',
      purpose: 'generation',
      provider: 'openai-compatible',
      baseUrl: 'https://llm.example.com/v1',
      model: 'gpt-test',
      ...overrides,
    },
  });
}

export function createEnvironment(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/environments`,
    session: actor.session,
    payload: {
      name: 'staging',
      apiBaseUrl: 'https://api.example.com',
      ...overrides,
    },
  });
}

export function createNotificationChannel(
  context: TestAppContext,
  actor: SeededActor,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return authedRequest(context.app, {
    method: 'POST',
    url: `/api/v1/projects/${projectId}/notification-channels`,
    session: actor.session,
    payload: {
      name: 'Release Bot',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456',
      secret: 'feishu-signing-secret',
      events: ['run_finished', 'run_failed'],
      ...overrides,
    },
  });
}
