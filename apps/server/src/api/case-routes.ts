// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CaseService } from '../cases/case-service.js';
import {
  MIGRATION_CONFLICT_POLICIES,
  type CaseMigrationService,
} from '../cases/case-migration-service.js';
import { parseInput } from './parse.js';
import { CASE_STORAGES } from '@gait/shared';

const projectParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
const caseQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    module: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const migrateCasesSchema = z
  .object({
    direction: z.enum(['repo_to_db', 'db_to_repo']),
    /** 只迁移这些路径；省略则迁移全部 feature + 资源文件。 */
    paths: z.array(z.string().trim().min(1).max(400)).max(2_000).optional(),
    /** 冲突策略：默认 skip（不覆盖已有内容）。 */
    conflictPolicy: z.enum(MIGRATION_CONFLICT_POLICIES).default('skip'),
  })
  .strict();

const caseStorageSchema = z.object({ caseStorage: z.enum(CASE_STORAGES) }).strict();

export interface CaseApiDependencies {
  guards: AuthGuards;
  caseService: CaseService;
  caseMigrationService: CaseMigrationService;
}

export function registerCaseRoutes(api: FastifyInstance, dependencies: CaseApiDependencies): void {
  const { guards, caseService, caseMigrationService } = dependencies;

  api.get(
    '/projects/:id/feature-files',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await caseService.listFiles(getAuthContext(request), params.id) };
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

      return { items: await caseService.listCases(getAuthContext(request), params.id, query) };
    },
  );

  /** 当前用例存储位置 + 两侧文件数 + 待导出数量。 */
  api.get(
    '/projects/:id/case-storage',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return await caseMigrationService.caseStorageStatus(getAuthContext(request), params.id);
    },
  );

  /** 切换用例存储位置（repo ⇄ db），带两侧一致性校验。 */
  api.put(
    '/projects/:id/case-storage',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(caseStorageSchema, request.body);

      return await caseMigrationService.setCaseStorage(
        getAuthContext(request),
        params.id,
        body.caseStorage,
      );
    },
  );

  /**
   * 用例迁移（repo ⇄ db）。两条方向都复用同一入口，`direction` 决定流向。
   * 冲突默认 skip，返回明细供前端逐项确认。
   */
  api.post(
    '/projects/:id/case-migrations',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(migrateCasesSchema, request.body);
      const input = {
        projectId: params.id,
        direction: body.direction,
        conflictPolicy: body.conflictPolicy,
        ...(body.paths === undefined ? {} : { paths: body.paths }),
      };

      return body.direction === 'repo_to_db'
        ? await caseMigrationService.repoToDb(getAuthContext(request), input)
        : await caseMigrationService.dbToRepo(getAuthContext(request), input);
    },
  );
}
