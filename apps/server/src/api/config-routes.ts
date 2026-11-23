// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, PERMISSION } from '@gait/shared';
import type { AuditLogWriter } from '@gait/db';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CredentialService } from '../projects/credential-service.js';
import type { EnvironmentService } from '../projects/environment-service.js';
import type { LlmProfileService } from '../projects/llm-profile-service.js';
import type { NotificationService } from '../projects/notification-service.js';
import type { ProjectAccessService } from '../projects/project-access-service.js';
import type { ProjectService } from '../projects/project-service.js';
import {
  credentialParamsSchema,
  credentialTestSchema,
  createCredentialSchema,
  createEnvironmentSchema,
  createLlmProfileSchema,
  createNotificationChannelSchema,
  createProjectSchema,
  environmentGroupParamsSchema,
  environmentGroupSchema,
  environmentParamsSchema,
  llmProfileParamsSchema,
  notificationChannelParamsSchema,
  projectAccessUpdateSchema,
  projectMemberAddSchema,
  projectMemberParamsSchema,
  projectMemberUpdateSchema,
  projectParamsSchema,
  updateCredentialSchema,
  updateEnvironmentSchema,
  updateLlmProfileSchema,
  updateNotificationChannelSchema,
  updateProjectSchema,
} from './config-schemas.js';
import { parseInput } from './parse.js';

export interface ConfigApiDependencies {
  guards: AuthGuards;
  projectService: ProjectService;
  projectAccessService: ProjectAccessService;
  auditWriter: AuditLogWriter;
  credentialService: CredentialService;
  llmProfileService: LlmProfileService;
  environmentService: EnvironmentService;
  notificationService: NotificationService;
}

function tenantIdFromParams(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;

  return typeof id === 'string' ? id : '';
}

/** 项目与配置路由；统一挂载在 /api/v1 下，继承 CSRF 与错误处理。 */
export function registerConfigRoutes(
  api: FastifyInstance,
  dependencies: ConfigApiDependencies,
): void {
  const {
    guards,
    projectService,
    projectAccessService,
    auditWriter,
    credentialService,
    llmProfileService,
    environmentService,
    notificationService,
  } = dependencies;
  const requireActiveTenantParam = async (request: FastifyRequest): Promise<void> => {
    guards.requireActiveTenant(request, tenantIdFromParams(request));
  };

  api.get(
    '/tenants/:id/projects',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.PROJECT_READ),
      ],
    },
    async (request) => ({ items: await projectService.list(getAuthContext(request)) }),
  );

  api.post(
    '/tenants/:id/projects',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.PROJECT_CREATE),
      ],
    },
    async (request, reply) => {
      const context = getAuthContext(request);
      const body = parseInput(createProjectSchema, request.body);
      const project = await projectService.create(context, body);

      reply.status(201);
      return { project };
    },
  );

  api.get(
    '/projects/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { project: await projectService.get(getAuthContext(request), params.id) };
    },
  );

  api.patch(
    '/projects/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(updateProjectSchema, request.body);

      return { project: await projectService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/projects/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_DELETE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);

      await projectService.remove(getAuthContext(request), params.id);
      reply.status(204).send();
    },
  );

  api.get(
    '/projects/:id/access',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const context = getAuthContext(request);

      return { access: await projectAccessService.view(context, params.id) };
    },
  );

  api.patch(
    '/projects/:id/access',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(projectAccessUpdateSchema, request.body);
      const context = getAuthContext(request);
      const access = await projectAccessService.updateAccessMode(
        context,
        params.id,
        body.accessMode,
      );

      await auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.PROJECT_ACCESS_UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
        resourceId: params.id,
        detail: { accessMode: body.accessMode },
        now: Date.now(),
      });

      return { access };
    },
  );

  api.post(
    '/projects/:id/members',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(projectMemberAddSchema, request.body);
      const context = getAuthContext(request);
      const access = await projectAccessService.addMember(
        context,
        params.id,
        body.username,
        body.role,
      );

      await auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.PROJECT_MEMBER_ADD,
        resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
        resourceId: params.id,
        detail: { username: body.username, role: body.role },
        now: Date.now(),
      });

      return { access };
    },
  );

  api.patch(
    '/projects/:id/members/:userId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectMemberParamsSchema, request.params);
      const body = parseInput(projectMemberUpdateSchema, request.body);
      const context = getAuthContext(request);
      const access = await projectAccessService.updateMember(
        context,
        params.id,
        params.userId,
        body.role,
      );

      await auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.PROJECT_MEMBER_UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
        resourceId: params.id,
        detail: { userId: params.userId, role: body.role },
        now: Date.now(),
      });

      return { access };
    },
  );

  api.delete(
    '/projects/:id/members/:userId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request, reply) => {
      const params = parseInput(projectMemberParamsSchema, request.params);
      const context = getAuthContext(request);

      await projectAccessService.removeMember(context, params.id, params.userId);
      await auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.PROJECT_MEMBER_REMOVE,
        resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
        resourceId: params.id,
        detail: { userId: params.userId },
        now: Date.now(),
      });
      reply.status(204).send();
    },
  );

  api.post(
    '/projects/:id/test-connection',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return await projectService.testConnection(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/environment-groups',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await environmentService.listGroups(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/environment-groups',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(environmentGroupSchema, request.body);

      reply.status(201);
      return {
        group: await environmentService.createGroup(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/projects/:id/environment-groups/:groupId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(environmentGroupParamsSchema, request.params);

      await environmentService.deleteGroup(getAuthContext(request), params.id, params.groupId);
      reply.status(204).send();
    },
  );

  api.get(
    '/projects/:id/credentials',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await credentialService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/credentials',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(createCredentialSchema, request.body);
      const credential = await credentialService.create(getAuthContext(request), params.id, body);

      reply.status(201);
      return { credential };
    },
  );

  api.patch(
    '/credentials/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_WRITE)],
    },
    async (request) => {
      const params = parseInput(credentialParamsSchema, request.params);
      const body = parseInput(updateCredentialSchema, request.body);

      return {
        credential: await credentialService.update(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/credentials/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(credentialParamsSchema, request.params);

      await credentialService.remove(getAuthContext(request), params.id);
      reply.status(204).send();
    },
  );

  api.post(
    '/credentials/:id/test',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_WRITE)],
    },
    async (request) => {
      const params = parseInput(credentialParamsSchema, request.params);
      const body = parseInput(credentialTestSchema, request.body ?? {});

      return await credentialService.test(getAuthContext(request), params.id, body.repoUrl);
    },
  );

  api.get(
    '/projects/:id/llm-profiles',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await llmProfileService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/llm-profiles',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(createLlmProfileSchema, request.body);
      const profile = await llmProfileService.create(getAuthContext(request), params.id, body);

      reply.status(201);
      return { profile };
    },
  );

  api.patch(
    '/llm-profiles/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request) => {
      const params = parseInput(llmProfileParamsSchema, request.params);
      const body = parseInput(updateLlmProfileSchema, request.body);

      return {
        profile: await llmProfileService.update(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/llm-profiles/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(llmProfileParamsSchema, request.params);

      await llmProfileService.remove(getAuthContext(request), params.id);
      reply.status(204).send();
    },
  );

  api.post(
    '/llm-profiles/:id/test',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request) => {
      const params = parseInput(llmProfileParamsSchema, request.params);

      return await llmProfileService.test(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/environments',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await environmentService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/environments',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(createEnvironmentSchema, request.body);
      const environment = await environmentService.create(getAuthContext(request), params.id, body);

      reply.status(201);
      return { environment };
    },
  );

  api.patch(
    '/environments/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request) => {
      const params = parseInput(environmentParamsSchema, request.params);
      const body = parseInput(updateEnvironmentSchema, request.body);

      return {
        environment: await environmentService.update(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/environments/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(environmentParamsSchema, request.params);

      await environmentService.remove(getAuthContext(request), params.id);
      reply.status(204).send();
    },
  );

  api.post(
    '/environments/:id/test',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request) => {
      const params = parseInput(environmentParamsSchema, request.params);

      return await environmentService.test(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/notification-channels',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await notificationService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/notification-channels',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(createNotificationChannelSchema, request.body);
      const channel = await notificationService.create(getAuthContext(request), params.id, body);

      reply.status(201);
      return { channel };
    },
  );

  api.patch(
    '/notification-channels/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request) => {
      const params = parseInput(notificationChannelParamsSchema, request.params);
      const body = parseInput(updateNotificationChannelSchema, request.body);

      return {
        channel: await notificationService.update(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/notification-channels/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(notificationChannelParamsSchema, request.params);

      await notificationService.remove(getAuthContext(request), params.id);
      reply.status(204).send();
    },
  );

  api.post(
    '/notification-channels/:id/test',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request) => {
      const params = parseInput(notificationChannelParamsSchema, request.params);

      return await notificationService.test(getAuthContext(request), params.id);
    },
  );
}
