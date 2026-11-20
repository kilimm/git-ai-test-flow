// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { GenerationService } from '../generations/generation-service.js';
import { parseInput } from './parse.js';
import {
  approveGenerationSchema,
  createGenerationSchema,
  editGenerationFileSchema,
  generationFileParamsSchema,
  generationParamsSchema,
  rejectGenerationSchema,
} from './generation-schemas.js';

export interface GenerationApiDependencies {
  guards: AuthGuards;
  generationService: GenerationService;
}

export function registerGenerationRoutes(
  api: FastifyInstance,
  dependencies: GenerationApiDependencies,
): void {
  const { guards, generationService } = dependencies;

  api.post(
    '/projects/:id/generations',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_CREATE)],
    },
    async (request, reply) => {
      const params = parseInput(generationParamsSchema, request.params);
      const body = parseInput(createGenerationSchema, request.body);
      const result = generationService.create(getAuthContext(request), params.id, body);

      reply.status(result.created ? 201 : 200);
      return { generation: result.generation, created: result.created };
    },
  );

  api.get(
    '/projects/:id/generations',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(generationParamsSchema, request.params);

      return { items: generationService.list(getAuthContext(request), params.id) };
    },
  );

  api.get(
    '/generations/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(generationParamsSchema, request.params);

      return { generation: generationService.get(getAuthContext(request), params.id) };
    },
  );

  api.patch(
    '/generations/:id/files/:fileId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_APPROVE)],
    },
    async (request) => {
      const params = parseInput(generationFileParamsSchema, request.params);
      const body = parseInput(editGenerationFileSchema, request.body);
      const generation = await generationService.editFile(
        getAuthContext(request),
        params.id,
        params.fileId,
        body.content,
      );

      return { generation };
    },
  );

  api.post(
    '/generations/:id/approve',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_APPROVE)],
    },
    async (request) => {
      const params = parseInput(generationParamsSchema, request.params);
      const body = parseInput(approveGenerationSchema, request.body ?? {});

      return generationService.approve(getAuthContext(request), params.id, body);
    },
  );

  api.post(
    '/generations/:id/reject',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_APPROVE)],
    },
    async (request) => {
      const params = parseInput(generationParamsSchema, request.params);
      const body = parseInput(rejectGenerationSchema, request.body ?? {});
      const generation = generationService.reject(getAuthContext(request), params.id, body);

      return { generation };
    },
  );
}
