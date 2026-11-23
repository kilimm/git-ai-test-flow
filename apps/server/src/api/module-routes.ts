// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { JOB_TYPE_MODULE_SCAN, PERMISSION } from '@gait/shared';
import type { ModuleTreeNode } from '@gait/shared';
import { JobQueue, ProjectRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import { parseInput } from './parse.js';
import { requireProject } from '../projects/support.js';

/** 与 Worker 端保持一致的 settings_json 保留键。 */
export const MODULE_SCAN_SETTING_KEY = 'moduleScan';

interface PersistedModuleScan {
  modules: ModuleTreeNode[];
  scannedFiles: number;
  truncated: boolean;
  ref?: string;
  scannedAt?: number;
}

/** 从 projects.settings_json 读取 Worker 持久化的扫描结果（跨进程部署时使用）。 */
function readPersistedScan(settingsJson: string): PersistedModuleScan | undefined {
  try {
    const parsed: unknown = JSON.parse(settingsJson);

    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }

    const value = (parsed as Record<string, unknown>)[MODULE_SCAN_SETTING_KEY];

    return value !== null && typeof value === 'object' ? (value as PersistedModuleScan) : undefined;
  } catch {
    return undefined;
  }
}

export const moduleScanParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const moduleScanBodySchema = z
  .object({ ref: z.string().trim().min(1).max(255).optional() })
  .strict();

export interface ModuleApiDependencies {
  guards: AuthGuards;
  db: AppDatabase;
  queue?: JobQueue;
  /** 进程内读取最近一次扫描结果（与 Worker 同进程时可用）。 */
  readLatest?: (
    tenantId: string,
    projectId: string,
  ) =>
    | {
        modules: ModuleTreeNode[];
        scannedFiles: number;
        truncated: boolean;
        cached: boolean;
        scannedAt?: number;
      }
    | undefined;
  now?: () => number;
}

/**
 * 模块清单接口：
 * - GET  返回 Worker 最近一次扫描结果（可能为空，前端再做按需触发）；
 * - POST 触发一次扫描 job（幂等 dedupe），不直接阻塞返回模块树。
 *
 * 设计取舍：扫描需要拉取产品仓库快照，不能放在 API 同步路径；API 只负责投递任务。
 */
export function registerModuleRoutes(
  api: FastifyInstance,
  dependencies: ModuleApiDependencies,
): void {
  const { guards, db } = dependencies;
  const queue = dependencies.queue ?? new JobQueue(db);
  const clock = dependencies.now ?? (() => Date.now());

  api.get(
    '/projects/:id/modules',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_CREATE)],
    },
    async (request) => {
      const params = parseInput(moduleScanParamsSchema, request.params);
      const context = getAuthContext(request);
      const project = await requireProject(new ProjectRepository(db, context.tenant.id), params.id);
      const latest = dependencies.readLatest?.(context.tenant.id, project.id);
      const persisted = latest === undefined ? readPersistedScan(project.settingsJson) : undefined;
      const scannedAt = latest?.scannedAt ?? persisted?.scannedAt;

      return {
        projectId: project.id,
        modules: latest?.modules ?? persisted?.modules ?? [],
        scannedFiles: latest?.scannedFiles ?? persisted?.scannedFiles ?? 0,
        truncated: latest?.truncated ?? persisted?.truncated ?? false,
        scannedAt: scannedAt === undefined ? null : new Date(scannedAt).toISOString(),
      };
    },
  );

  api.post(
    '/projects/:id/modules/scan',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.GENERATION_CREATE)],
    },
    async (request, reply) => {
      const params = parseInput(moduleScanParamsSchema, request.params);
      const body = parseInput(moduleScanBodySchema, request.body ?? {});
      const context = getAuthContext(request);
      const project = await requireProject(new ProjectRepository(db, context.tenant.id), params.id);
      const ref = body.ref ?? project.defaultBranch;

      await queue.enqueue({
        type: JOB_TYPE_MODULE_SCAN,
        payload: { projectId: project.id, ...(body.ref === undefined ? {} : { ref: body.ref }) },
        tenantId: context.tenant.id,
        priority: 20,
        dedupeKey: `module-scan:${project.id}:${ref}`,
        maxAttempts: 1,
        now: clock(),
      });

      reply.status(202);
      return { queued: true, projectId: project.id, ref };
    },
  );
}
