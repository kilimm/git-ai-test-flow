// 本文件所有改动要求遵循 agent-rules 规范
import { CASE_STORAGE } from '@gait/shared';
import type { CaseStorage } from '@gait/shared';
import type { CaseBlobRepository } from '@gait/db';
import type { SuiteRepository } from '@gait/git';

/** 一个用例相关文件的读取视图：路径 + 内容（两种存储后端统一形态）。 */
export interface CaseFile {
  path: string;
  content: string;
}

/** 随用例一起迁移的资源目录（不含 docs/ai 与 steps）。 */
export const CASE_BUNDLE_RESOURCE_DIRS = ['schemas', 'templates', 'fixtures'] as const;

/** 允许迁移的文件扩展名；其余（二进制/图片）跳过。 */
export const CASE_BUNDLE_EXTENSIONS = [
  '.feature',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.mjs',
  '.js',
  '.sql',
  '.txt',
] as const;

/**
 * 文件是否属于「用例包」：feature 文件或资源目录下的可迁移文件。
 *
 * DB 模式下 resources（schemas/templates/fixtures）与 features 一起入库，
 * 否则 `JSON Schema "schemas/x.json"` 这类相对路径引用会读不到。
 */
export function isCaseBundlePath(path: string, featureRoot: string): boolean {
  if (!CASE_BUNDLE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return false;
  }

  const prefix = featureRoot.replace(/\/+$/, '');

  if (path.startsWith(`${prefix}/`)) {
    return true;
  }

  return CASE_BUNDLE_RESOURCE_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

export interface CaseStore {
  readonly storage: CaseStorage;
  /** 只返回 feature 文件（用例执行用）。 */
  listFeatureFiles(): Promise<CaseFile[]>;
  /** 返回用例包内的任意文件（资源解析用）。 */
  readFile(path: string): Promise<string | null>;
}

/** repo 模式：Git worktree 是事实源。 */
export class RepoCaseStore implements CaseStore {
  readonly storage = CASE_STORAGE.REPO;

  constructor(private readonly suite: SuiteRepository) {}

  async listFeatureFiles(): Promise<CaseFile[]> {
    const files = await this.suite.listFeatureFiles();

    return files.map((file) => ({ path: file.path, content: file.content }));
  }

  async readFile(path: string): Promise<string | null> {
    return this.suite.readFile(path);
  }
}

/**
 * db 模式：数据库是事实源。
 * 可见范围与 repo 模式一致（features/** 与资源目录）。
 */
export class DbCaseStore implements CaseStore {
  readonly storage = CASE_STORAGE.DB;

  constructor(
    private readonly repository: CaseBlobRepository,
    private readonly projectId: string,
    private readonly featureRoot: string,
  ) {}

  async listFeatureFiles(): Promise<CaseFile[]> {
    const rows = await this.repository.listByProject(this.projectId);
    const prefix = this.featureRoot.replace(/\/+$/, '');

    return rows
      .filter((row) => row.path.startsWith(`${prefix}/`) && row.path.endsWith('.feature'))
      .map((row) => ({ path: row.path, content: row.content }));
  }

  async readFile(path: string): Promise<string | null> {
    if (!isCaseBundlePath(path, this.featureRoot)) {
      return null;
    }

    const row = await this.repository.findByPath(this.projectId, path);

    return row?.content ?? null;
  }
}
