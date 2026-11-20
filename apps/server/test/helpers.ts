// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { hashPassword, loadEnv } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { MembershipRepository, TenantRepository, UserRepository } from '@gait/db';
import type { AppDatabase, Tenant, User } from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { MEMBER_STATUS, SESSION_COOKIE_NAME, USER_STATUS } from '@gait/shared';
import type { TenantRole, UserStatus } from '@gait/shared';
import { buildApp } from '../src/app.js';
import type { GitLsRemote } from '../src/config/git-client.js';
import type { HttpClient } from '../src/config/http-client.js';
import type { DnsLookup } from '../src/config/ssrf.js';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../src/csrf.js';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_PASSWORD = 'test-password-123';

export function createTestEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ...overrides,
  });
}

export interface TestAppContext {
  app: FastifyInstance;
  database: TestDatabase;
  env: AppEnv;
}

export interface CreateTestAppOptions {
  envOverrides?: Record<string, string | undefined>;
  now?: () => number;
  httpClient?: HttpClient;
  dnsLookup?: DnsLookup;
  gitLsRemote?: GitLsRemote;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestAppContext> {
  const database = createTestDatabase();
  const env = createTestEnv(options.envOverrides);
  const app = await buildApp({
    env,
    db: database.db,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
    ...(options.dnsLookup === undefined ? {} : { dnsLookup: options.dnsLookup }),
    ...(options.gitLsRemote === undefined ? {} : { gitLsRemote: options.gitLsRemote }),
  });

  return { app, database, env };
}

export async function closeTestApp(context: TestAppContext): Promise<void> {
  await context.app.close();
  context.database.cleanup();
}

export function seedTenant(db: AppDatabase, slug = 'acme', name = 'Acme'): Tenant {
  return new TenantRepository(db).create({ slug, name });
}

export interface SeedUserOptions {
  username: string;
  tenantId: string;
  role: TenantRole;
  password?: string;
  email?: string;
  status?: UserStatus;
  isPlatformAdmin?: boolean;
}

export async function seedUser(db: AppDatabase, options: SeedUserOptions): Promise<User> {
  const user = new UserRepository(db).create({
    username: options.username,
    email: options.email ?? null,
    passwordHash: await hashPassword(options.password ?? TEST_PASSWORD),
    displayName: options.username,
    status: options.status ?? USER_STATUS.ACTIVE,
    isPlatformAdmin: options.isPlatformAdmin ?? false,
  });

  new MembershipRepository(db, options.tenantId).add({
    userId: user.id,
    role: options.role,
    status: MEMBER_STATUS.ACTIVE,
  });

  return user;
}

function splitSetCookies(response: LightMyRequestResponse): string[] {
  const header = response.headers['set-cookie'];
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header];

  return values.flatMap((value) => value.split(/,(?=[^;]+?=)/));
}

/** 将响应中的 Set-Cookie 合并进 Cookie 集合；后续请求统一用 cookieHeader 拼接。 */
export function mergeCookies(
  response: LightMyRequestResponse,
  existing: Map<string, string> = new Map(),
): Map<string, string> {
  for (const header of splitSetCookies(response)) {
    const pair = header.split(';', 1)[0]?.trim();

    if (pair === undefined || pair.length === 0) {
      continue;
    }

    const separator = pair.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    existing.set(pair.slice(0, separator), pair.slice(separator + 1));
  }

  return existing;
}

export function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies.entries()]
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export interface BrowserSession {
  cookies: Map<string, string>;
  csrfToken: string;
}

export async function bootstrapCsrf(app: FastifyInstance): Promise<BrowserSession> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
  const body = response.json() as { csrfToken: string };
  const cookies = mergeCookies(response);

  return { cookies, csrfToken: body.csrfToken };
}

export interface LoginResult {
  response: LightMyRequestResponse;
  cookies: Map<string, string>;
  csrfToken: string;
}

export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
  session?: BrowserSession,
): Promise<LoginResult> {
  const base = session ?? (await bootstrapCsrf(app));
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
    headers: {
      cookie: cookieHeader(base.cookies),
      [CSRF_HEADER_NAME]: base.csrfToken,
    },
  });
  const cookies = mergeCookies(response, new Map(base.cookies));

  return { response, cookies, csrfToken: base.csrfToken };
}

export function sessionCookieOf(cookies: Map<string, string>): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME);
}

export function csrfCookieOf(cookies: Map<string, string>): string | undefined {
  return cookies.get(CSRF_COOKIE_NAME);
}

export interface AuthedRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  url: string;
  session: LoginResult | BrowserSession;
  payload?: unknown;
}

/** 带会话 Cookie 与 CSRF 头的请求；无 payload 的变更请求同样带上 CSRF。 */
export async function authedRequest(
  app: FastifyInstance,
  options: AuthedRequestOptions,
): Promise<LightMyRequestResponse> {
  const { session } = options;
  const unsafe = options.method !== 'GET';
  const response = await app.inject({
    method: options.method,
    url: options.url,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    headers: {
      cookie: cookieHeader(session.cookies),
      ...(unsafe ? { [CSRF_HEADER_NAME]: session.csrfToken } : {}),
    },
  });

  mergeCookies(response, session.cookies);

  return response;
}
