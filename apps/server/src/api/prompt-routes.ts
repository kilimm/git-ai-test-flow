// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { PromptTemplateService } from '../prompts/prompt-template-service.js';
import { parseInput } from './parse.js';

const stageParamsSchema = z.object({ stage: z.string().trim().min(1).max(32) }).strict();
const savePromptSchema = z
  .object({ content: z.string().max(60_000) })
  .strict();

export interface PromptApiDependencies {
  guards: AuthGuards;
  promptTemplateService: PromptTemplateService;
}

/** 生成阶段提示词管理：列表 + 保存（按租户隔离）。 */
export function registerPromptRoutes(
  api: FastifyInstance,
  dependencies: PromptApiDependencies,
): void {
  const { guards, promptTemplateService } = dependencies;

  api.get(
    '/prompt-templates',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.TENANT_UPDATE)],
    },
    async (request) => {
      return { items: await promptTemplateService.list(getAuthContext(request)) };
    },
  );

  api.put(
    '/prompt-templates/:stage',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.TENANT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(stageParamsSchema, request.params);
      const body = parseInput(savePromptSchema, request.body);

      return {
        stage: await promptTemplateService.save(
          getAuthContext(request),
          params.stage,
          body.content,
        ),
      };
    },
  );
}
