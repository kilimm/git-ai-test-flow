// 本文件所有改动要求遵循 agent-rules 规范
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { PERMISSION } from '@gait/shared';
import { listRecentCommits, resolveCommit, syncMirror } from '@gait/git';
import { ProjectRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import type { AppEnv } from '@gait/config';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import { parseInput } from './parse.js';
import { requireProject } from '../projects/support.js';

export const commitsParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const commitsQuerySchema = z
  .object({
    ref: z.string().trim().min(1).max(255).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export interface CommitsApiDependencies {
  guards: AuthGuards;
  db: AppDatabase;
  env: Pick<AppEnv, 'DATA_DIR'>;
}

/**
 * 项目提交历史接口。
 *
 * 前端创建运行时需要填写 Head/Base SHA，手输 SHA 体验差且易错，
 * 因此提供最近提交列表供下拉选择（按提交时间倒序）。
 *
 * 取舍：直接读本地产品镜像（Worker 与 API 共用 DATA_DIR）；
 * 镜像不存在或拉取失败时返回空列表而不是 500，避免阻断创建运行流程。
 */
export function registerCommitRoutes(
  api: FastifyInstance,
  dependencies: CommitsApiDependencies,
): void {
  const { guards, db, env } = dependencies;

  api.get(
    '/projects/:id/commits',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.RUN_CREATE)],
    },
    async (request, reply) => {
      const params = parseInput(commitsParamsSchema, request.params);
      const query = parseInput(commitsQuerySchema, request.query ?? {});
      const context = getAuthContext(request);
      const project = await requireProject(new ProjectRepository(db, context.tenant.id), params.id);

      if (project.productRepoUrl.length === 0) {
        reply.status(409);
        return {
          code: 'PRODUCT_REPO_REQUIRED',
          detail: '项目未配置产品仓库，无法读取提交历史',
        };
      }

      const mirrorPath = join(env.DATA_DIR, 'git', 'mirrors', `product-${project.id}.git`);

      try {
        // 镜像缺失时先拉一次；已有镜像则增量更新。
        await syncMirror({ repoUrl: project.productRepoUrl, mirrorPath });
      } catch (cause) {
        request.log.warn(
          { err: cause instanceof Error ? cause.message : String(cause), projectId: project.id },
          'sync mirror for commits failed',
        );

        if (!existsSync(mirrorPath)) {
          return { items: [], headSha: null, warning: '无法同步产品仓库，提交历史不可用' };
        }
      }

      const ref = query.ref ?? project.defaultBranch;
      let headSha: string | null;

      try {
        headSha = await resolveCommit(mirrorPath, ref);
      } catch {
        // defaultBranch 不存在时退回 HEAD（镜像默认分支）。
        try {
          headSha = await resolveCommit(mirrorPath, 'HEAD');
        } catch {
          headSha = null;
        }
      }

      if (headSha === null) {
        return { items: [], headSha: null, warning: '仓库中没有可用提交' };
      }

      const commits = await listRecentCommits({
        repoPath: mirrorPath,
        ref: headSha,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });

      return {
        items: commits.map((commit) => ({
          sha: commit.sha,
          shortSha: commit.shortSha,
          title: commit.title,
          author: commit.author,
          committedAt: new Date(commit.committedAt).toISOString(),
        })),
        headSha,
        latestSha: commits[0]?.sha ?? headSha,
      };
    },
  );
}
