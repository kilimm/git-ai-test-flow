// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { DocService } from '../docs/doc-service.js';
import { parseInput } from './parse.js';

const idSchema = z.string().min(1).max(64);
const projectParamSchema = z.object({ id: idSchema }).strict();
const moduleParamSchema = z.object({ id: idSchema }).strict();
const regenerateSchema = z
  .object({
    headSha: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional(),
  })
  .strict();
const editSchema = z.object({ content: z.string().min(1).max(500_000) }).strict();
const diffQuerySchema = z.object({ from: idSchema, to: idSchema }).strict();
const entriesQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
  .strict();
const versionsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();
const modulesQuerySchema = z.object({ query: z.string().trim().max(200).optional() }).strict();

export interface DocApiDependencies {
  guards: AuthGuards;
  docService: DocService;
}

export function registerDocRoutes(api: FastifyInstance, dependencies: DocApiDependencies): void {
  const { guards, docService } = dependencies;

  api.get(
    '/projects/:id/doc-modules',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamSchema, request.params);
      const query = parseInput(modulesQuerySchema, request.query);

      return {
        items: await docService.listModules(getAuthContext(request), params.id, query.query),
      };
    },
  );

  api.get(
    '/projects/:id/doc-entries',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamSchema, request.params);
      const query = parseInput(entriesQuerySchema, request.query);

      return {
        items: await docService.listEntries(getAuthContext(request), params.id, query.limit),
      };
    },
  );

  api.get(
    '/projects/:id/doc-rollups',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamSchema, request.params);

      return { items: await docService.rollups(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/projects/:id/docs/regenerate',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.DOC_EDIT)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamSchema, request.params);
      const body = parseInput(regenerateSchema, request.body ?? {});
      const result = await docService.regenerate(getAuthContext(request), params.id, body.headSha);

      reply.status(202);
      return result;
    },
  );

  api.post(
    '/projects/:id/docs/compress',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.DOC_EDIT)],
    },
    async (request, reply) => {
      const params = parseInput(projectParamSchema, request.params);

      reply.status(202);
      return await docService.compress(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/doc-modules/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(moduleParamSchema, request.params);

      return await docService.getModule(getAuthContext(request), params.id);
    },
  );

  api.get(
    '/doc-modules/:id/versions',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(moduleParamSchema, request.params);
      const query = parseInput(versionsQuerySchema, request.query);

      return {
        items: await docService.listVersions(getAuthContext(request), params.id, query.limit),
      };
    },
  );

  api.get(
    '/doc-modules/:id/diff',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(moduleParamSchema, request.params);
      const query = parseInput(diffQuerySchema, request.query);

      return await docService.diff(getAuthContext(request), params.id, query.from, query.to);
    },
  );

  api.patch(
    '/doc-modules/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.DOC_EDIT)],
    },
    async (request) => {
      const params = parseInput(moduleParamSchema, request.params);
      const body = parseInput(editSchema, request.body);

      return {
        version: await docService.edit(getAuthContext(request), params.id, body.content),
      };
    },
  );
}
