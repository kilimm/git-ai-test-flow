// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import { parseInput } from './parse.js';
import type { RunService } from '../runs/run-service.js';
import { createRunSchema, runParamsSchema } from './run-schemas.js';

export interface RunApiDependencies {
  guards: AuthGuards;
  runService: RunService;
}

export function registerRunRoutes(api: FastifyInstance, dependencies: RunApiDependencies): void {
  const { guards, runService } = dependencies;

  api.post(
    '/projects/:id/runs',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.RUN_CREATE)],
    },
    async (request, reply) => {
      const params = parseInput(runParamsSchema, request.params);
      const body = parseInput(createRunSchema, request.body);
      const result = runService.create(getAuthContext(request), params.id, body);

      reply.status(result.created ? 201 : 200);

      return { run: result.run, created: result.created };
    },
  );

  api.get(
    '/projects/:id/runs',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { items: runService.list(getAuthContext(request), params.id) };
    },
  );

  api.get(
    '/runs/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { run: runService.get(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/runs/:id/cancel',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.RUN_CANCEL)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { run: runService.cancel(getAuthContext(request), params.id) };
    },
  );
}
