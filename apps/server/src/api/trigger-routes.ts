// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSION, TRIGGER_ACTIONS, TRIGGER_TYPES } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { TriggerService } from '../triggers/trigger-service.js';
import { parseInput } from './parse.js';

const idSchema = z.string().min(1).max(64);
const projectParamsSchema = z.object({ id: idSchema }).strict();
const triggerParamsSchema = z.object({ id: idSchema, triggerId: idSchema }).strict();

const selectionSchema = z
  .object({
    type: z.enum(['all', 'modules', 'cases', 'impact']).default('all'),
    modules: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    caseKeys: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
  })
  .strict();

const createTriggerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(TRIGGER_TYPES),
    action: z.enum(TRIGGER_ACTIONS),
    enabled: z.boolean().optional(),
    cron: z.string().trim().min(9).max(100).optional(),
    branch: z.string().trim().min(1).max(255).optional(),
    environmentId: idSchema.optional(),
    selection: selectionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === 'schedule' && value.cron === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['cron'],
        message: 'cron is required for schedule triggers',
      });
    }

    if (value.type === 'deployment' && value.action !== 'run') {
      context.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'deployment triggers must use action=run',
      });
    }
  });

const updateTriggerSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    cron: z.string().trim().min(9).max(100).nullable().optional(),
    branch: z.string().trim().min(1).max(255).nullable().optional(),
    environmentId: idSchema.nullable().optional(),
    selection: selectionSchema.optional(),
    rotateToken: z.boolean().optional(),
  })
  .strict();

export interface TriggerApiDependencies {
  guards: AuthGuards;
  triggerService: TriggerService;
}

export function registerTriggerRoutes(
  api: FastifyInstance,
  dependencies: TriggerApiDependencies,
): void {
  const { guards, triggerService } = dependencies;

  api.get(
    '/projects/:id/triggers',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await triggerService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/triggers',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(createTriggerSchema, request.body);
      const result = await triggerService.create(getAuthContext(request), params.id, body);

      reply.status(201);
      return result;
    },
  );

  api.patch(
    '/projects/:id/triggers/:triggerId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(triggerParamsSchema, request.params);
      const body = parseInput(updateTriggerSchema, request.body);
      const { rotateToken, ...update } = body;

      return await triggerService.update(
        getAuthContext(request),
        params.id,
        params.triggerId,
        update,
        rotateToken === true,
      );
    },
  );

  api.delete(
    '/projects/:id/triggers/:triggerId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request, reply) => {
      const params = parseInput(triggerParamsSchema, request.params);

      await triggerService.remove(getAuthContext(request), params.id, params.triggerId);
      reply.status(204).send();
    },
  );
}

function tokenOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const bearer =
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const custom = request.headers['x-gait-token'];
  const customToken = Array.isArray(custom) ? custom[0] : custom;

  return bearer ?? customToken ?? '';
}

export interface PublicWebhookDependencies {
  triggerService: TriggerService;
}

/** 公开回调不经过会话/CSRF，仅依赖每个触发器的随机 token。 */
export function registerPublicWebhookRoutes(
  app: FastifyInstance,
  dependencies: PublicWebhookDependencies,
): void {
  app.post('/webhooks/git/:projectId', async (request) => {
    const projectId = (request.params as { projectId?: string }).projectId ?? '';

    return await dependencies.triggerService.fireWebhook({
      projectId,
      token: tokenOf(request),
      type: 'git_webhook',
      payload: request.body,
    });
  });

  app.post('/webhooks/deploy/:projectId', async (request) => {
    const projectId = (request.params as { projectId?: string }).projectId ?? '';

    return await dependencies.triggerService.fireWebhook({
      projectId,
      token: tokenOf(request),
      type: 'deployment',
      payload: request.body,
    });
  });
}
