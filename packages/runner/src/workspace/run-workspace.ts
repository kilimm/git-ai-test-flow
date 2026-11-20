// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';
import { ensureDirectory } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { addWorktree, removeWorktree, resolveCommit, syncMirror } from '@gait/git';
import { SuiteRepository } from '@gait/git';
import { repoRelativePathIssues } from '@gait/shared';
import type { SuiteMode } from '@gait/shared';
import { RUN_ERROR_CODE, RUN_LIMITS } from '@gait/shared';

export class WorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

export interface RunWorkspaceOptions {
  dataDir: string;
  tenantId: string;
  projectId: string;
  projectSlug: string;
  runId: string;
  productRepoUrl: string;
  suiteMode: SuiteMode;
  suiteRepoUrl?: string | null;
  suitePath?: string | null;
  featureRoot?: string;
  headSha: string;
  gitAuth?: GitAuth | null;
  signal?: AbortSignal;
  maxBytes?: number;
}

function assertSafeSegment(value: string): string {
  if (value.length === 0 || value === '.' || value === '..' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new WorkspaceError(RUN_ERROR_CODE.WORKSPACE_FAILED, 'Unsafe workspace path segment');
  }

  return value;
}

function directorySize(root: string): number {
  if (!existsSync(root)) {
    return 0;
  }

  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolute = join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        try {
          total += statSync(absolute).size;
        } catch {
          // 文件在遍历时被删除时忽略。
        }
      }
    }
  }

  return total;
}

/**
 * 单次 Run 的隔离工作区：
 * - product/ 是产品镜像的只读 worktree，仅用于源码上下文；
 * - Suite 通过 SuiteRepository 提供 feature/fixtures 读取；
 * - logs/ 与 tmp/ 用于执行期临时文件；
 * - 关闭时删除 worktree 并清理目录，产物单独保存在 data/artifacts。
 */
export class RunWorkspace {
  readonly root: string;
  readonly productRoot: string;
  readonly logsDir: string;
  readonly tmpDir: string;
  suite!: SuiteRepository;
  private readonly options: RunWorkspaceOptions;
  private readonly mirrorPath: string;
  private closed = false;

  private constructor(options: RunWorkspaceOptions) {
    this.options = options;
    this.root = join(
      options.dataDir,
      'workspaces',
      assertSafeSegment(options.tenantId),
      assertSafeSegment(options.projectId),
      assertSafeSegment(options.runId),
    );
    this.productRoot = join(this.root, 'product');
    this.logsDir = join(this.root, 'logs');
    this.tmpDir = join(this.root, 'tmp');
    this.mirrorPath = join(options.dataDir, 'git', 'mirrors', `product-${options.projectId}.git`);
  }

  get mirror(): string {
    return this.mirrorPath;
  }

  static async open(options: RunWorkspaceOptions): Promise<RunWorkspace> {
    const workspace = new RunWorkspace(options);

    try {
      await workspace.initialize();
      return workspace;
    } catch (error) {
      await workspace.close();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const { options } = this;

    ensureDirectory(this.root);
    ensureDirectory(this.logsDir);
    ensureDirectory(this.tmpDir);
    await syncMirror({
      repoUrl: options.productRepoUrl,
      mirrorPath: this.mirrorPath,
      ...(options.gitAuth === null || options.gitAuth === undefined
        ? {}
        : { auth: options.gitAuth }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const commit = await resolveCommit(this.mirrorPath, options.headSha, {
      ...(options.gitAuth === null || options.gitAuth === undefined
        ? {}
        : { auth: options.gitAuth }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    await addWorktree({
      mirrorPath: this.mirrorPath,
      worktreePath: this.productRoot,
      ref: commit,
      ...(options.gitAuth === null || options.gitAuth === undefined
        ? {}
        : { auth: options.gitAuth }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const suite = await SuiteRepository.open({
      mode: options.suiteMode,
      projectId: options.projectId,
      projectSlug: options.projectSlug,
      projectRepoUrl: options.productRepoUrl,
      suiteRepoUrl: options.suiteRepoUrl ?? null,
      suitePath: options.suitePath ?? null,
      ...(options.featureRoot === undefined ? {} : { featureRoot: options.featureRoot }),
      dataDir: options.dataDir,
      worktreeRoot: join(this.root, 'suite-worktrees'),
      headSha: commit,
      ...(options.gitAuth === null || options.gitAuth === undefined
        ? {}
        : { auth: options.gitAuth }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    this.suite = suite;
    await this.assertQuota();
  }

  /** 产品目录仅提供读取入口；调用方无法通过该 API 写入。 */
  readProductFile(relativePath: string): string | null {
    const issues = repoRelativePathIssues(relativePath);

    if (issues.length > 0) {
      throw new WorkspaceError(RUN_ERROR_CODE.WORKSPACE_FAILED, issues.join('; '));
    }

    const absolute = normalize(join(this.productRoot, relativePath));

    if (absolute !== this.productRoot && !absolute.startsWith(`${this.productRoot}${sep}`)) {
      throw new WorkspaceError(RUN_ERROR_CODE.WORKSPACE_FAILED, 'Product path escapes workspace');
    }

    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  }

  productRelativePath(absolutePath: string): string {
    return relative(this.productRoot, absolutePath).split(sep).join('/');
  }

  async assertQuota(): Promise<void> {
    const maxBytes = this.options.maxBytes ?? RUN_LIMITS.DEFAULT_WORKSPACE_MAX_BYTES;
    const bytes = directorySize(this.root);

    if (bytes > maxBytes) {
      throw new WorkspaceError(
        RUN_ERROR_CODE.WORKSPACE_QUOTA_EXCEEDED,
        `Workspace exceeds ${maxBytes} bytes (actual ${bytes})`,
      );
    }
  }

  /** 关闭时即使部分清理失败也要继续，返回错误消息供审计。 */
  async close(): Promise<string[]> {
    if (this.closed) {
      return [];
    }

    this.closed = true;
    const errors: string[] = [];

    if (this.suite !== undefined) {
      try {
        await this.suite.dispose();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      await removeWorktree(this.mirrorPath, this.productRoot);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return errors;
  }
}
