// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthRequiredError, ForbiddenError, NotFoundError } from '@gait/config';
import { AuditLogWriter } from '@gait/db';
import { AUDIT_ACTION, roleHasPermission } from '@gait/shared';
import type { Permission } from '@gait/shared';
import { clearSessionCookie, readSessionToken } from './session-token.js';
import type { ProjectAccessService } from '../projects/project-access-service.js';
import type { AuthContext, AuthService, RequestMeta } from './auth-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function getRequestMeta(request: FastifyRequest): RequestMeta {
  const header = request.headers['user-agent'];
  const userAgent = Array.isArray(header) ? (header[0] ?? null) : (header ?? null);

  return { ip: request.ip ?? null, userAgent };
}

export function getAuthContext(request: FastifyRequest): AuthContext {
  if (request.auth === undefined) {
    throw new AuthRequiredError();
  }

  return request.auth;
}

export interface AuthGuards {
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requirePermission: (
    permission: Permission,
  ) => (request: FastifyRequest, _reply: FastifyReply) => Promise<void>;
  requireActiveTenant: (request: FastifyRequest, tenantId: string) => void;
}

export interface CreateGuardsOptions {
  authService: AuthService;
  auditWriter: AuditLogWriter;
  projectAccess?: ProjectAccessService;
}

/**
 * 认证与授权守卫。
 * - tenant 上下文只来自会话；
 * - 跨租户（含不存在租户）统一 404，避免泄漏资源存在性；
 * - 权限拒绝写入审计日志。
 */
export function createAuthGuards(options: CreateGuardsOptions): AuthGuards {
  const { authService, auditWriter, projectAccess } = options;

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const context = authService.authenticate(readSessionToken(request));

    if (context === undefined) {
      clearSessionCookie(reply);
      throw new AuthRequiredError();
    }

    request.auth = context;
    projectAccess?.assertRequestAccess(context, request.url, request.params, request.method);
  };

  const requirePermission =
    (permission: Permission) =>
    async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const context = getAuthContext(request);

      if (!roleHasPermission(context.role, permission)) {
        auditWriter.append({
          tenantId: context.tenant.id,
          actorUserId: context.user.id,
          action: AUDIT_ACTION.AUTHORIZATION_DENIED,
          detail: {
            permission,
            method: request.method,
            path: request.url.split('?')[0] ?? request.url,
          },
        });
        throw new ForbiddenError('Permission denied');
      }
    };

  const requireActiveTenant = (request: FastifyRequest, tenantId: string): void => {
    const context = getAuthContext(request);

    if (context.tenant.id !== tenantId) {
      throw new NotFoundError('Tenant not found');
    }
  };

  return { requireAuth, requirePermission, requireActiveTenant };
}
