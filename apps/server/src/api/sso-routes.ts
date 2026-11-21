// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AppEnv } from '@gait/config';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext, getRequestMeta } from '../auth/guards.js';
import { readSessionToken, sessionCookieSecure, setSessionCookie } from '../auth/session-token.js';
import { SSO_STATE_COOKIE } from '../auth/sso-service.js';
import type { SsoService } from '../auth/sso-service.js';
import { parseInput } from './parse.js';

const providerParamsSchema = z.object({ providerId: z.string().min(1).max(64) }).strict();
const tenantSlugParamsSchema = z.object({ tenantSlug: z.string().min(1).max(64) }).strict();
const callbackQuerySchema = z
  .object({ code: z.string().min(1).max(4_096), state: z.string().min(1).max(4_096) })
  .strict();
const startQuerySchema = z.object({ redirect: z.string().max(500).optional() }).strict();
const createProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    issuer: z.url().max(2_048),
    clientId: z.string().trim().min(1).max(256),
    clientSecret: z.string().min(1).max(8_192),
    authorizationEndpoint: z.url().max(2_048),
    tokenEndpoint: z.url().max(2_048),
    userinfoEndpoint: z.url().max(2_048),
    scopes: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    allowedEmailDomains: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
    defaultRole: z.enum(['viewer', 'developer', 'admin']).optional(),
  })
  .strict();
const updateProviderSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedEmailDomains: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
    defaultRole: z.enum(['viewer', 'developer', 'admin']).optional(),
    clientSecret: z.string().min(1).max(8_192).optional(),
  })
  .strict();

export interface SsoApiDependencies {
  env: AppEnv;
  guards: AuthGuards;
  ssoService: SsoService;
}

function cookieFrom(request: FastifyRequest, name: string): string | undefined {
  return request.cookies?.[name];
}

export function registerSsoRoutes(api: FastifyInstance, dependencies: SsoApiDependencies): void {
  const { env, guards, ssoService } = dependencies;
  const secure = sessionCookieSecure(env.NODE_ENV);
  const requireActiveTenantParam = async (request: FastifyRequest): Promise<void> => {
    const id = (request.params as { id?: unknown }).id;

    guards.requireActiveTenant(request, typeof id === 'string' ? id : '');
  };

  api.get('/auth/sso/:tenantSlug/providers', async (request) => {
    const params = parseInput(tenantSlugParamsSchema, request.params);

    return { items: ssoService.listProviders(params.tenantSlug) };
  });

  api.get('/auth/sso/:providerId/start', async (request, reply) => {
    const params = parseInput(providerParamsSchema, request.params);
    const query = parseInput(startQuerySchema, request.query);
    const result = await ssoService.start(params.providerId, query.redirect);

    reply.setCookie(SSO_STATE_COOKIE, result.state, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 600,
    });

    return reply.redirect(result.url, 302);
  });

  api.get('/auth/sso/:providerId/callback', async (request, reply) => {
    const params = parseInput(providerParamsSchema, request.params);
    const query = parseInput(callbackQuerySchema, request.query);
    const stateCookie = cookieFrom(request, SSO_STATE_COOKIE);
    const meta = getRequestMeta(request);

    if (stateCookie === undefined) {
      return reply.status(400).send({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'SSO_STATE_INVALID',
        detail: 'SSO state cookie is missing',
      });
    }

    const result = await ssoService.callback({
      providerId: params.providerId,
      code: query.code,
      state: query.state,
      cookieState: stateCookie,
      ip: meta.ip,
      userAgent: meta.userAgent,
      existingToken: readSessionToken(request) ?? null,
    });

    reply.clearCookie(SSO_STATE_COOKIE, { path: '/' });
    setSessionCookie(reply, result.token, secure);
    const webBase = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const redirect =
      result.redirectPath === '/'
        ? `/t/${result.tenantSlug}/projects`
        : result.redirectPath.startsWith('/t/')
          ? result.redirectPath
          : `/t/${result.tenantSlug}${result.redirectPath}`;

    return reply.redirect(`${webBase}${redirect}`, 302);
  });

  api.get(
    '/tenants/:id/sso-providers',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_UPDATE),
      ],
    },
    async (request) => ({ items: ssoService.listAdmin(getAuthContext(request)) }),
  );

  api.post(
    '/tenants/:id/sso-providers',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_UPDATE),
      ],
    },
    async (request, reply) => {
      const body = parseInput(createProviderSchema, request.body);

      reply.status(201);
      return {
        provider: await ssoService.createProvider(getAuthContext(request), body),
      };
    },
  );

  api.patch(
    '/tenants/:id/sso-providers/:providerId',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_UPDATE),
      ],
    },
    async (request) => {
      const params = parseInput(providerParamsSchema, request.params);
      const body = parseInput(updateProviderSchema, request.body);

      return {
        provider: ssoService.updateProvider(getAuthContext(request), params.providerId, body),
      };
    },
  );

  api.delete(
    '/tenants/:id/sso-providers/:providerId',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_UPDATE),
      ],
    },
    async (request, reply) => {
      const params = parseInput(providerParamsSchema, request.params);

      ssoService.removeProvider(getAuthContext(request), params.providerId);
      reply.status(204).send();
    },
  );
}
