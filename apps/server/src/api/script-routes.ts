// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION, SCRIPT_KINDS, SCRIPT_STATUSES } from '@gait/shared';
import type { ScriptKind, ScriptStatus } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import { parseInput } from './parse.js';
import type { ScriptLibraryService } from '../scripts/script-library-service.js';

const scriptIdSchema = z.string().min(1).max(64);
const scriptParamsSchema = z.object({ id: scriptIdSchema }).strict();
const listQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    modules: z.string().trim().max(500).optional(),
    kinds: z.string().trim().max(200).optional(),
    statuses: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const paramSpecSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    type: z.enum(['string', 'int', 'word', 'method', 'jsonPath', 'anything']),
    required: z.boolean().optional(),
    description: z.string().trim().max(500),
    example: z.string().max(500).optional(),
  })
  .strict();

const createScriptSchema = z
  .object({
    moduleKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/)
      .max(120),
    name: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(120),
    kind: z.enum(SCRIPT_KINDS),
    pattern: z.string().trim().min(3).max(500),
    description: z.string().trim().max(1_000).default(''),
    params: z.array(paramSpecSchema).max(20).optional(),
    examples: z.array(z.string().max(500)).max(10).optional(),
    source: z.string().max(200_000).optional(),
  })
  .strict();

const updateScriptSchema = z
  .object({
    description: z.string().trim().max(1_000).optional(),
    params: z.array(paramSpecSchema).max(20).optional(),
    examples: z.array(z.string().max(500)).max(10).optional(),
    source: z.string().max(200_000).optional(),
    status: z.enum(SCRIPT_STATUSES).optional(),
  })
  .strict();

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length === 0 ? undefined : items;
}

export interface ScriptApiDependencies {
  guards: AuthGuards;
  scriptLibraryService: ScriptLibraryService;
}

/**
 * 脚本库 API（tenant 级）。
 *
 * - 读：所有成员可读（需要知道有哪些 step 可复用）；
 * - 写：需 project:update 权限；
 * - draft → active 需显式调用 activate，语义是「已用真实用例验证通过」。
 */
export function registerScriptRoutes(
  api: FastifyInstance,
  dependencies: ScriptApiDependencies,
): void {
  const { guards, scriptLibraryService } = dependencies;

  api.get('/scripts', { preHandler: [guards.requireAuth] }, async (request) => {
    const query = parseInput(listQuerySchema, request.query ?? {});
    const kinds = splitList(query.kinds);
    const statuses = splitList(query.statuses);

    const modules = splitList(query.modules);

    return {
      items: await scriptLibraryService.list(getAuthContext(request), {
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(modules === undefined ? {} : { modules }),
        ...(kinds === undefined ? {} : { kinds: kinds as ScriptKind[] }),
        ...(statuses === undefined ? {} : { statuses: statuses as ScriptStatus[] }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
    };
  });

  api.get('/scripts/:id', { preHandler: [guards.requireAuth] }, async (request) => {
    const params = parseInput(scriptParamsSchema, request.params);

    return await scriptLibraryService.get(getAuthContext(request), params.id);
  });

  api.post(
    '/scripts',
    { preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)] },
    async (request, reply) => {
      const body = parseInput(createScriptSchema, request.body);
      const result = await scriptLibraryService.create(getAuthContext(request), {
        moduleKey: body.moduleKey,
        name: body.name,
        kind: body.kind,
        pattern: body.pattern,
        description: body.description,
        ...(body.params === undefined ? {} : { params: body.params }),
        ...(body.examples === undefined ? {} : { examples: body.examples }),
        ...(body.source === undefined ? {} : { source: body.source }),
      });

      reply.status(result.ok ? 201 : 409);

      return result;
    },
  );

  api.patch(
    '/scripts/:id',
    { preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)] },
    async (request) => {
      const params = parseInput(scriptParamsSchema, request.params);
      const body = parseInput(updateScriptSchema, request.body);

      return await scriptLibraryService.update(getAuthContext(request), params.id, {
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.params === undefined ? {} : { params: body.params }),
        ...(body.examples === undefined ? {} : { examples: body.examples }),
        ...(body.source === undefined ? {} : { source: body.source }),
        ...(body.status === undefined ? {} : { status: body.status }),
      });
    },
  );

  api.post(
    '/scripts/:id/activate',
    { preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)] },
    async (request) => {
      const params = parseInput(scriptParamsSchema, request.params);

      return await scriptLibraryService.activate(getAuthContext(request), params.id);
    },
  );
}
