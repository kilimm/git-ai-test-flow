// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CaseService } from '../cases/case-service.js';
import { parseInput } from './parse.js';

const projectParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
const caseQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    module: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export interface CaseApiDependencies {
  guards: AuthGuards;
  caseService: CaseService;
}

export function registerCaseRoutes(api: FastifyInstance, dependencies: CaseApiDependencies): void {
  const { guards, caseService } = dependencies;

  api.get(
    '/projects/:id/feature-files',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: caseService.listFiles(getAuthContext(request), params.id) };
    },
  );

  api.get(
    '/projects/:id/cases',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const query = parseInput(caseQuerySchema, request.query);

      return { items: caseService.listCases(getAuthContext(request), params.id, query) };
    },
  );
}
