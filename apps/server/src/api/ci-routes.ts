// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CiService } from '../integrations/ci-service.js';
import { parseInput } from './parse.js';

const idSchema = z.string().min(1).max(64);
const projectParamsSchema = z.object({ id: idSchema }).strict();
const ciParamsSchema = z.object({ id: idSchema, ciId: idSchema }).strict();
const upsertCiSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(['github', 'gitlab']),
    repository: z.string().trim().min(3).max(200),
    apiBaseUrl: z.url().max(2_048).optional(),
    tokenCredentialId: idSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const publishSchema = z
  .object({
    runId: idSchema,
    pullRequestNumber: z.number().int().min(1).max(10_000_000),
  })
  .strict();

export interface CiApiDependencies {
  guards: AuthGuards;
  ciService: CiService;
}

export function registerCiRoutes(api: FastifyInstance, dependencies: CiApiDependencies): void {
  const { guards, ciService } = dependencies;

  api.get(
    '/projects/:id/ci-integrations',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await ciService.list(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/ci-integrations',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(upsertCiSchema, request.body);

      reply.status(201);
      return {
        integration: await ciService.upsert(getAuthContext(request), params.id, body),
      };
    },
  );

  api.delete(
    '/projects/:id/ci-integrations/:ciId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request, reply) => {
      const params = parseInput(ciParamsSchema, request.params);

      await ciService.remove(getAuthContext(request), params.id, params.ciId);
      reply.status(204).send();
    },
  );

  api.post(
    '/projects/:id/ci-integrations/:ciId/test',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(ciParamsSchema, request.params);

      return await ciService.test(getAuthContext(request), params.id, params.ciId);
    },
  );

  api.post(
    '/projects/:id/ci-integrations/:ciId/publish',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(ciParamsSchema, request.params);
      const body = parseInput(publishSchema, request.body);

      return await ciService.publish(getAuthContext(request), {
        projectId: params.id,
        integrationId: params.ciId,
        runId: body.runId,
        pullRequestNumber: body.pullRequestNumber,
      });
    },
  );
}
