// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { CaseService } from '../cases/case-service.js';
import type { CaseAuthoringService, ModuleOperation } from '../cases/case-authoring-service.js';
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
    page: z.coerce.number().int().min(1).max(1_000_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
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

const caseFileSchema = z
  .object({ path: z.string().trim().min(1).max(400) })
  .strict();
const saveCaseContentSchema = z
  .object({
    path: z.string().trim().min(1).max(400),
    content: z.string().min(1).max(2 * 1024 * 1024),
  })
  .strict();
const moveModuleSchema = z
  .object({
    path: z.string().trim().min(1).max(400),
    moduleKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, '非法模块 key')
      .max(120),
  })
  .strict();
const editModulesSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            type: z.enum(['rename', 'delete']),
            from: z.string().trim().min(1).max(120),
            to: z.string().trim().min(1).max(120).optional(),
            deleteCases: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export interface CaseApiDependencies {
  guards: AuthGuards;
  caseService: CaseService;
  caseMigrationService: CaseMigrationService;
  caseAuthoringService: CaseAuthoringService;
}

export function registerCaseRoutes(api: FastifyInstance, dependencies: CaseApiDependencies): void {
  const { guards, caseService, caseMigrationService, caseAuthoringService } = dependencies;

  /** 读取用例文件内容（含 repo/db 两侧状态），供在线编辑器使用。 */
  api.get(
    '/projects/:id/case-files',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const query = parseInput(caseFileSchema, request.query);

      return await caseAuthoringService.getFile(getAuthContext(request), params.id, query.path);
    },
  );

  /** 保存用例内容（自动分流到 Git / case_blobs）并重建索引。 */
  api.put(
    '/projects/:id/case-files',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(saveCaseContentSchema, request.body);

      return await caseAuthoringService.saveFile(
        getAuthContext(request),
        params.id,
        body.path,
        body.content,
      );
    },
  );

  /** 整文件改模块归属（重写全部场景的 @module 标签）。 */
  api.post(
    '/projects/:id/case-files/move-module',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(moveModuleSchema, request.body);

      return await caseAuthoringService.moveModule(
        getAuthContext(request),
        params.id,
        body.path,
        body.moduleKey,
      );
    },
  );

  /** 用例模块树（按 @module 标签聚合，方便把用例放入正确路径）。 */
  api.get(
    '/projects/:id/case-modules',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);

      return { items: await caseAuthoringService.caseModuleTree(getAuthContext(request), params.id) };
    },
  );

  /** 单个模块快照：文件 + 用例 + 模块树，一次请求返回（列表页点选模块用）。 */
  api.get(
    '/projects/:id/case-modules/snapshot',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const query = parseInput(
        z.object({ module: z.string().trim().min(1).max(120) }).strict(),
        request.query,
      );

      return await caseAuthoringService.moduleSnapshot(
        getAuthContext(request),
        params.id,
        query.module,
      );
    },
  );

  /** 模块内用例列表。 */
  api.get(
    '/projects/:id/case-modules/cases',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const query = parseInput(
        z.object({ module: z.string().trim().min(1).max(120) }).strict(),
        request.query,
      );

      return {
        items: await caseAuthoringService.listCasesInModule(
          getAuthContext(request),
          params.id,
          query.module,
        ),
      };
    },
  );

  /** 模块批量编辑：重命名 / 删除（删除可指定连带删用例或改为 unknown）。 */
  api.post(
    '/projects/:id/case-modules/edit',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_UPDATE)],
    },
    async (request) => {
      const params = parseInput(projectParamsSchema, request.params);
      const body = parseInput(editModulesSchema, request.body);
      const operations: ModuleOperation[] = body.operations.map((operation) => ({
        type: operation.type,
        from: operation.from,
        ...(operation.to === undefined ? {} : { to: operation.to }),
        ...(operation.deleteCases === undefined ? {} : { deleteCases: operation.deleteCases }),
      }));

      return {
        items: await caseAuthoringService.editModules(
          getAuthContext(request),
          params.id,
          operations,
        ),
      };
    },
  );

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
      const { page, pageSize, ...filter } = parseInput(caseQuerySchema, request.query);

      return await caseService.listCases(getAuthContext(request), params.id, {
        ...filter,
        ...(page === undefined && pageSize === undefined
          ? {}
          : {
              limit: pageSize ?? 20,
              offset: ((page ?? 1) - 1) * (pageSize ?? 20),
            }),
      });
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
