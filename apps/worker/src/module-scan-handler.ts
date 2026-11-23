// 本文件所有改动要求遵循 agent-rules 规范
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createEncryptionKey, SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { CredentialRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, Project } from '@gait/db';
import { CREDENTIAL_TYPE, buildModuleTree } from '@gait/shared';
import type { ModuleTreeNode } from '@gait/shared';
import {
  collectSnapshotDiff,
  ensureDirectory,
  filterDiffFiles,
  resolveCommit,
  syncMirror,
} from '@gait/git';
import type { GitAuth } from '@gait/git';
import { inferModulesFromPath } from '@gait/agent';
import type { JobHandler } from './job-handler.js';
import type { WorkerLogger } from './worker.js';

export interface ModuleScanHandlerOptions {
  db: AppDatabase;
  env: AppEnv;
  logger?: WorkerLogger;
  now?: () => number;
}

export interface ModuleScanPayload {
  projectId: string;
  /** 扫描目标：commit/branch，缺省用项目默认分支。 */
  ref?: string;
}

/** 模块扫描缓存有效期：避免每次打开表单都拉一次镜像。 */
const CACHE_TTL_MS = 10 * 60 * 1_000;
const SCAN_MAX_FILES = 2_000;

interface CacheEntry {
  expiresAt: number;
  modules: ModuleTreeNode[];
  scannedFiles: number;
  truncated: boolean;
}

/** 进程内缓存；Worker 单进程运行，重启后自然失效，不引入额外存储。 */
const cache = new Map<string, CacheEntry>();

/**
 * 最近一次扫描结果（按租户+项目）：API 层通过本进程内 Map 读取。
 * 与 API 同进程部署时直接可用；跨进程部署后续可通过 jobs.result_json 补齐。
 */
const latestResults = new Map<string, ModuleScanResult>();

/**
 * 跨进程持久化最近一次扫描结果：API 与 Worker 分机部署时，API 读不到进程内 Map，
 * 因此把结果写入 projects.settings_json 下的保留键（不影响其他设置）。
 */
export const MODULE_SCAN_SETTING_KEY = 'moduleScan';

export async function persistModuleScanResult(
  db: AppDatabase,
  tenantId: string,
  projectId: string,
  result: ModuleScanResult,
): Promise<void> {
  try {
    const projects = new ProjectRepository(db, tenantId);
    const project = await projects.findById(projectId);

    if (project === undefined) {
      return;
    }

    let settings: Record<string, unknown> = {};

    try {
      const parsed: unknown = JSON.parse(project.settingsJson);
      settings =
        parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      settings = {};
    }

    settings[MODULE_SCAN_SETTING_KEY] = result;
    await projects.update(projectId, { settingsJson: JSON.stringify(settings) });
  } catch {
    // 持久化失败不影响扫描结果本身（进程内 Map 仍可用）。
  }
}

export async function readPersistedModuleScanResult(
  db: AppDatabase,
  tenantId: string,
  projectId: string,
): Promise<ModuleScanResult | undefined> {
  try {
    const project = await new ProjectRepository(db, tenantId).findById(projectId);

    if (project === undefined) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(project.settingsJson);

    if (parsed === null || typeof parsed !== 'object') {
      return undefined;
    }

    const value = (parsed as Record<string, unknown>)[MODULE_SCAN_SETTING_KEY];

    return value !== null && typeof value === 'object' ? (value as ModuleScanResult) : undefined;
  } catch {
    return undefined;
  }
}

export interface ModuleScanResult {
  modules: ModuleTreeNode[];
  scannedFiles: number;
  truncated: boolean;
  cached: boolean;
  ref: string;
  scannedAt: number;
}

function latestKey(tenantId: string, projectId: string): string {
  return `${tenantId}:${projectId}`;
}

export function readLatestModuleScan(
  tenantId: string,
  projectId: string,
): ModuleScanResult | undefined {
  return latestResults.get(latestKey(tenantId, projectId));
}

export function clearModuleScanState(): void {
  cache.clear();
  latestResults.clear();
}

function payloadOf(payload: unknown): ModuleScanPayload {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { projectId?: unknown }).projectId !== 'string'
  ) {
    throw new Error('module.scan payload must contain projectId');
  }

  const raw = payload as { projectId: string; ref?: unknown };

  return {
    projectId: raw.projectId,
    ...(typeof raw.ref === 'string' && raw.ref.length > 0 ? { ref: raw.ref } : {}),
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,})/g, '****').slice(0, 500);
}

/** 统一缓存 key：项目 + 目标 ref。 */
export function moduleScanCacheKey(projectId: string, ref: string): string {
  return `${projectId}:${ref}`;
}

/**
 * 模块清单扫描：只用「路径推断」（不调用 LLM），保证快速、确定、可缓存。
 * - 以空树为 base 拉取代码库快照，逐个文件映射到层级模块 key；
 * - 同一模块下按文件数计数，父节点由 buildModuleTree 自动补全；
 * - 超过 SCAN_MAX_FILES 或 diff 预算被裁剪时，返回 truncated 标记。
 *
 * 扫描结果同时写入进程内 Map 与 projects.settings_json（moduleScan 键），
 * 后者供 API 跨进程读取。
 */
export function createModuleScanJobHandler(options: ModuleScanHandlerOptions): JobHandler {
  const { db, env } = options;
  const clock = options.now ?? (() => Date.now());
  const cipher = new SecretCipher(
    createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION),
  );

  return async (context) => {
    const { projectId } = payloadOf(context.payload);
    const tenantId = context.job.tenantId;

    if (tenantId === null) {
      throw new Error('module.scan job is missing tenantId');
    }

    const project: Project | undefined = await new ProjectRepository(db, tenantId).findById(
      projectId,
    );

    if (project === undefined) {
      throw new Error('Project not found');
    }

    const ref = payloadOf(context.payload).ref ?? project.defaultBranch;
    const cacheKey = moduleScanCacheKey(project.id, ref);
    const cached = cache.get(cacheKey);

    if (cached !== undefined && cached.expiresAt > clock()) {
      const cachedResult: ModuleScanResult = {
        modules: cached.modules,
        scannedFiles: cached.scannedFiles,
        truncated: cached.truncated,
        cached: true,
        ref,
        scannedAt: clock(),
      };
      latestResults.set(latestKey(tenantId, project.id), cachedResult);
      await persistModuleScanResult(db, tenantId, project.id, cachedResult);

      return;
    }

    let gitAuth: GitAuth | null = null;

    if (project.gitCredentialId !== null) {
      const credential = await new CredentialRepository(db, tenantId).findById(
        project.gitCredentialId,
      );

      if (credential !== undefined && credential.type === CREDENTIAL_TYPE.GIT_PAT) {
        gitAuth = {
          ...(credential.username === null ? {} : { username: credential.username }),
          token: cipher.decrypt(tenantId, credential.id, credential.type, {
            ciphertext: credential.secretCiphertext,
            iv: credential.secretIv,
            authTag: credential.secretAuthTag,
            keyVersion: credential.keyVersion,
          }),
        };
      }
    }

    const mirrorsRoot = join(env.DATA_DIR, 'git', 'mirrors');
    ensureDirectory(mirrorsRoot);
    const projectMirror = join(mirrorsRoot, `product-${project.id}.git`);
    const scanMirror = join(mirrorsRoot, `module-scan-${randomUUID()}.git`);

    try {
      await syncMirror({
        repoUrl: project.productRepoUrl,
        mirrorPath: projectMirror,
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });

      // 临时浅镜像：只取目标提交，避免扫描一个超大仓库的全部历史。
      await syncMirror({
        repoUrl: project.productRepoUrl,
        mirrorPath: scanMirror,
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });
      const resolved = await resolveCommit(scanMirror, ref, {
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });
      const diff = await collectSnapshotDiff({
        repoPath: scanMirror,
        headSha: resolved,
        maxFiles: SCAN_MAX_FILES,
        ...(gitAuth === null ? {} : { auth: gitAuth }),
        signal: context.signal,
      });
      const filtered = filterDiffFiles(diff.files);
      const counts = new Map<string, number>();

      for (const file of filtered.files) {
        if (file.skipped) {
          continue;
        }

        for (const module of inferModulesFromPath(file.path)) {
          counts.set(module, (counts.get(module) ?? 0) + 1);
        }
      }

      const modules = buildModuleTree(
        [...counts.entries()].map(([key, count]) => ({ key, count })),
      );
      const truncated =
        diff.files.length >= SCAN_MAX_FILES ||
        filtered.stats.truncatedFiles > 0 ||
        filtered.stats.skippedFiles > 0;
      cache.set(cacheKey, {
        expiresAt: clock() + CACHE_TTL_MS,
        modules,
        scannedFiles: filtered.stats.includedFiles,
        truncated,
      });
      latestResults.set(latestKey(tenantId, project.id), {
        modules,
        scannedFiles: filtered.stats.includedFiles,
        truncated,
        cached: false,
        ref,
        scannedAt: clock(),
      });
      await persistModuleScanResult(db, tenantId, project.id, {
        modules,
        scannedFiles: filtered.stats.includedFiles,
        truncated,
        cached: false,
        ref,
        scannedAt: clock(),
      });
    } catch (error) {
      options.logger?.warn({ err: error, projectId }, 'module scan failed');
      throw new Error(`Module scan failed: ${safeError(error)}`, { cause: error });
    } finally {
      rmSync(scanMirror, { recursive: true, force: true });
    }
  };
}
