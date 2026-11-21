// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppEnv } from '@gait/config';
import { toIsoUtc } from '@gait/config';
import { TenantAuditLogRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { ForbiddenError } from '@gait/config';
import { CSRF_COOKIE_NAME, PERMISSION, permissionsForRole } from '@gait/shared';
import type { AuthSessionSummary, TenantSummary } from '@gait/shared';
import type { AuthService } from '../auth/auth-service.js';
import { toAuthUserSummary, toTenantSummary } from '../auth/auth-service.js';
import { getAuthContext, getRequestMeta } from '../auth/guards.js';
import type { AuthGuards } from '../auth/guards.js';
import {
  clearSessionCookie,
  readSessionToken,
  sessionCookieSecure,
  setSessionCookie,
} from '../auth/session-token.js';
import { createCsrfGuard, createCsrfToken, SAFE_METHODS, setCsrfCookie } from '../csrf.js';
import type { CaseService } from '../cases/case-service.js';
import type { GenerationService } from '../generations/generation-service.js';
import type { CredentialService } from '../projects/credential-service.js';
import type { EnvironmentService } from '../projects/environment-service.js';
import type { LlmProfileService } from '../projects/llm-profile-service.js';
import type { NotificationService } from '../projects/notification-service.js';
import type { ProjectService } from '../projects/project-service.js';
import type { OperationsService } from '../operations.js';
import type { RunService } from '../runs/run-service.js';
import { registerApiRateLimit } from '../security.js';
import type { MemberService } from '../tenants/member-service.js';
import type { TenantService } from '../tenants/tenant-service.js';
import { registerCaseRoutes } from './case-routes.js';
import { registerConfigRoutes } from './config-routes.js';
import { registerGenerationRoutes } from './generation-routes.js';
import { registerRunRoutes } from './run-routes.js';
import { parseInput } from './parse.js';
import {
  addMemberSchema,
  auditQuerySchema,
  changePasswordSchema,
  loginSchema,
  memberParamsSchema,
  switchTenantSchema,
  updateMemberRoleSchema,
  updateTenantSchema,
} from './schemas.js';

export const API_PREFIX = '/api/v1';

export interface ApiDependencies {
  env: AppEnv;
  db: AppDatabase;
  authService: AuthService;
  memberService: MemberService;
  tenantService: TenantService;
  guards: AuthGuards;
  projectService: ProjectService;
  credentialService: CredentialService;
  llmProfileService: LlmProfileService;
  environmentService: EnvironmentService;
  notificationService: NotificationService;
  generationService: GenerationService;
  runService: RunService;
  caseService: CaseService;
  operationsService: OperationsService;
  apiRateLimit?: { limit?: number; windowMs?: number };
}

function tenantSummary(value: {
  id: string;
  slug: string;
  name: string;
  role: TenantSummary['role'];
}): TenantSummary {
  return { id: value.id, slug: value.slug, name: value.name, role: value.role };
}

export async function registerApiRoutes(
  app: FastifyInstance,
  dependencies: ApiDependencies,
): Promise<void> {
  const {
    env,
    db,
    authService,
    memberService,
    tenantService,
    guards,
    projectService,
    credentialService,
    llmProfileService,
    environmentService,
    notificationService,
    generationService,
    runService,
    caseService,
    operationsService,
    apiRateLimit,
  } = dependencies;
  const secureCookie = sessionCookieSecure(env.NODE_ENV);
  const csrfSecret = env.SESSION_SECRET;

  /**
   * 先校验路径租户等于会话活动租户，再校验权限。
   * 这样任何角色的跨租户请求都统一 404，不会因 403 泄漏资源存在性。
   */
  const requireActiveTenantParam = async (request: FastifyRequest): Promise<void> => {
    const id = (request.params as { id?: unknown }).id;

    guards.requireActiveTenant(request, typeof id === 'string' ? id : '');
  };

  const apiPlugin: FastifyPluginAsync = async (api) => {
    registerApiRateLimit(api, apiRateLimit ?? {});
    api.addHook('onRequest', createCsrfGuard(csrfSecret));
    api.addHook('onRequest', async (request, reply) => {
      if (SAFE_METHODS.has(request.method) && request.cookies?.[CSRF_COOKIE_NAME] === undefined) {
        setCsrfCookie(reply, createCsrfToken(csrfSecret), secureCookie);
      }
    });

    api.get('/auth/csrf', async (_request, reply) => {
      const token = createCsrfToken(csrfSecret);
      setCsrfCookie(reply, token, secureCookie);

      return { csrfToken: token };
    });

    api.get('/metrics', { preHandler: guards.requireAuth }, async (request) => {
      const context = getAuthContext(request);

      if (!context.user.isPlatformAdmin) {
        throw new ForbiddenError('Platform administrator permission required');
      }

      return operationsService.metrics();
    });

    api.post('/auth/login', async (request, reply) => {
      const body = parseInput(loginSchema, request.body);
      const meta = getRequestMeta(request);
      const result = await authService.login({
        username: body.username,
        password: body.password,
        ip: meta.ip,
        userAgent: meta.userAgent,
        existingToken: readSessionToken(request) ?? null,
      });

      setSessionCookie(reply, result.token, secureCookie);

      const summary: AuthSessionSummary = {
        user: toAuthUserSummary(result.user),
        activeTenant: toTenantSummary(result.activeTenant),
        tenants: result.tenants.map(toTenantSummary),
        permissions: permissionsForRole(result.activeTenant.role),
      };

      return summary;
    });

    api.post('/auth/logout', async (request, reply) => {
      authService.logout(readSessionToken(request), getRequestMeta(request));
      clearSessionCookie(reply);
      reply.status(204).send();
    });

    api.get('/me', { preHandler: guards.requireAuth }, async (request) => {
      return authService.buildSessionSummary(getAuthContext(request));
    });

    api.patch('/me/password', { preHandler: guards.requireAuth }, async (request, reply) => {
      const context = getAuthContext(request);
      const body = parseInput(changePasswordSchema, request.body);

      await authService.changePassword(context, body);
      reply.status(204).send();
    });

    api.get('/me/tenants', { preHandler: guards.requireAuth }, async (request) => {
      const context = getAuthContext(request);

      return {
        items: authService.listTenantAccess(context.user.id).map(toTenantSummary),
      };
    });

    api.post('/me/active-tenant', { preHandler: guards.requireAuth }, async (request) => {
      const context = getAuthContext(request);
      const body = parseInput(switchTenantSchema, request.body);

      return authService.switchTenant(context, body.tenantId);
    });

    api.get(
      '/tenants/:id',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_READ),
        ],
      },
      async (request) => {
        const context = getAuthContext(request);

        return {
          tenant: tenantSummary({
            id: context.tenant.id,
            slug: context.tenant.slug,
            name: context.tenant.name,
            role: context.role,
          }),
        };
      },
    );

    api.patch(
      '/tenants/:id',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_UPDATE),
        ],
      },
      async (request) => {
        const context = getAuthContext(request);
        const body = parseInput(updateTenantSchema, request.body);

        return { tenant: tenantService.updateName(context, body.name) };
      },
    );

    api.get(
      '/tenants/:id/members',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_MEMBER_MANAGE),
        ],
      },
      async (request) => {
        const context = getAuthContext(request);

        return { items: memberService.list(context) };
      },
    );

    api.post(
      '/tenants/:id/members',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_MEMBER_MANAGE),
        ],
      },
      async (request, reply) => {
        const context = getAuthContext(request);
        const body = parseInput(addMemberSchema, request.body);
        const member = await memberService.addMember(context, body);

        reply.status(201);
        return { member };
      },
    );

    api.patch(
      '/tenants/:id/members/:userId',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_MEMBER_MANAGE),
        ],
      },
      async (request) => {
        const params = parseInput(memberParamsSchema, request.params);
        const context = getAuthContext(request);
        const body = parseInput(updateMemberRoleSchema, request.body);

        return { member: memberService.updateRole(context, params.userId, body.role) };
      },
    );

    api.delete(
      '/tenants/:id/members/:userId',
      {
        preHandler: [
          guards.requireAuth,
          requireActiveTenantParam,
          guards.requirePermission(PERMISSION.TENANT_MEMBER_MANAGE),
        ],
      },
      async (request, reply) => {
        const params = parseInput(memberParamsSchema, request.params);
        const context = getAuthContext(request);

        memberService.removeMember(context, params.userId);
        reply.status(204).send();
      },
    );

    api.get(
      '/audit-logs',
      {
        preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.AUDIT_READ)],
      },
      async (request) => {
        const context = getAuthContext(request);
        const query = parseInput(auditQuerySchema, request.query);
        const page = new TenantAuditLogRepository(db, context.tenant.id).list({
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.action === undefined ? {} : { action: query.action }),
          ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
        });

        return {
          items: page.items.map((item) => ({
            ...item,
            createdAt: toIsoUtc(item.createdAt),
          })),
          nextCursor: page.nextCursor,
        };
      },
    );

    registerConfigRoutes(api, {
      guards,
      projectService,
      credentialService,
      llmProfileService,
      environmentService,
      notificationService,
    });
    registerGenerationRoutes(api, { guards, generationService });
    registerRunRoutes(api, { guards, runService });
    registerCaseRoutes(api, { guards, caseService });
  };

  await app.register(apiPlugin, { prefix: API_PREFIX });
}
