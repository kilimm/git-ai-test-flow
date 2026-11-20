// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CredentialService } from '../projects/credential-service.js';
import type { EnvironmentService } from '../projects/environment-service.js';
import type { LlmProfileService } from '../projects/llm-profile-service.js';
import type { NotificationService } from '../projects/notification-service.js';
import type { ProjectService } from '../projects/project-service.js';
import {
  credentialParamsSchema,
  credentialTestSchema,
  createCredentialSchema,
  createEnvironmentSchema,
  createLlmProfileSchema,
  createNotificationChannelSchema,
  createProjectSchema,
  environmentParamsSchema,
  llmProfileParamsSchema,
  notificationChannelParamsSchema,
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
    async (request) => ({ items: projectService.list(getAuthContext(request)) }),
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
      const project = projectService.create(context, body);

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

      return { project: projectService.get(getAuthContext(request), params.id) };
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

      return { project: projectService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/projects/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_DELETE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);

      projectService.remove(getAuthContext(request), params.id);
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

      return projectService.testConnection(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/credentials',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: credentialService.list(getAuthContext(request), params.id) };
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
      const credential = credentialService.create(getAuthContext(request), params.id, body);

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

      return { credential: credentialService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/credentials/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.CREDENTIAL_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(credentialParamsSchema, request.params);

      credentialService.remove(getAuthContext(request), params.id);
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

      return credentialService.test(getAuthContext(request), params.id, body.repoUrl);
    },
  );

  api.get(
    '/projects/:id/llm-profiles',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: llmProfileService.list(getAuthContext(request), params.id) };
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
      const profile = llmProfileService.create(getAuthContext(request), params.id, body);

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

      return { profile: llmProfileService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/llm-profiles/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.LLM_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(llmProfileParamsSchema, request.params);

      llmProfileService.remove(getAuthContext(request), params.id);
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

      return llmProfileService.test(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/environments',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: environmentService.list(getAuthContext(request), params.id) };
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
      const environment = environmentService.create(getAuthContext(request), params.id, body);

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

      return { environment: environmentService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/environments/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.ENVIRONMENT_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(environmentParamsSchema, request.params);

      environmentService.remove(getAuthContext(request), params.id);
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

      return environmentService.test(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/projects/:id/notification-channels',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: notificationService.list(getAuthContext(request), params.id) };
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
      const channel = notificationService.create(getAuthContext(request), params.id, body);

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

      return { channel: notificationService.update(getAuthContext(request), params.id, body) };
    },
  );

  api.delete(
    '/notification-channels/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.NOTIFICATION_WRITE)],
    },
    async (request, reply) => {
      const params = parseInput(notificationChannelParamsSchema, request.params);

      notificationService.remove(getAuthContext(request), params.id);
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

      return notificationService.test(getAuthContext(request), params.id);
    },
  );
}
