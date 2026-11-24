// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_DOCS_ROOT,
  DEFAULT_FEATURE_ROOT,
  DEFAULT_SUITE_PATH,
  normalizeRepoDir,
} from '@gait/shared';
import type { SuiteMode } from '@gait/shared';
import { ensureDirectory, runGit } from './command.js';
import type { GitAuth } from './command.js';
import {
  addWorktree,
  removeWorktree,
  resolveCommit,
  resolveDefaultBranch,
  syncMirror,
} from './diff.js';

export interface SuiteRepositoryConfig {
  mode: SuiteMode;
  projectId: string;
  projectSlug: string;
  projectRepoUrl: string;
  suiteRepoUrl?: string | null;
  suitePath?: string | null;
  featureRoot?: string;
  docsRoot?: string;
  dataDir: string;
  /** 可选：把 external/same_repo 的 worktree 放到 Run 工作区内，便于统一清理。 */
  worktreeRoot?: string;
  headSha?: string | null;
  auth?: GitAuth | null;
  signal?: AbortSignal;
}

export interface SuiteFeatureFile {
  path: string;
  content: string;
  blobSha: string;
}

export interface SuiteFileInput {
  path: string;
  content: string;
}

export interface SuiteCommitResult {
  commitSha: string;
  changed: boolean;
  committedPaths: string[];
}

const MANAGED_BRANCH = 'main';
const SAME_REPO_BRANCH = 'gait/ai-tests';
const SUITE_DIRECTORIES = ['steps', 'fixtures', 'schemas', 'templates', 'docs/ai'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');

  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function pathInside(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe suite path: ${relativePath}`);
  }

  const resolved = normalize(join(root, relativePath));

  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes suite root: ${relativePath}`);
  }

  return resolved;
}

function walkFeatureFiles(root: string, current = ''): string[] {
  const directory = current.length === 0 ? root : join(root, current);

  if (!existsSync(directory)) {
    return [];
  }

  const results: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = current.length === 0 ? entry.name : `${current}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...walkFeatureFiles(root, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.feature')) {
      results.push(relativePath);
    }
  }

  return results.sort();
}

/**
 * Suite 仓库抽象：
 * - managed：平台在 DATA_DIR/suites 下维护本地 Git 仓库；
 * - external：镜像团队 Suite 仓库，提交后推回默认分支；
 * - same_repo：在产品仓库镜像上使用 gait/ai-tests 分支写入专用目录。
 */
export class SuiteRepository {
  private readonly config: SuiteRepositoryConfig;
  private readonly featureRootPrefix: string;
  private readonly docsRootPrefix: string;
  private repositoryRoot: string;
  private mirrorPath: string | null = null;
  private worktreePath: string | null = null;
  private targetBranch: string;
  private sameRepoBranch = false;

  private constructor(config: SuiteRepositoryConfig) {
    this.config = config;
    const featureRoot = normalizeRepoDir(config.featureRoot ?? DEFAULT_FEATURE_ROOT);
    this.featureRootPrefix =
      config.mode === 'same_repo'
        ? `${normalizeRepoDir(config.suitePath ?? DEFAULT_SUITE_PATH)}${featureRoot}`
        : featureRoot;
    const docsRoot = normalizeRepoDir(config.docsRoot ?? DEFAULT_DOCS_ROOT);
    this.docsRootPrefix =
      config.mode === 'same_repo'
        ? `${normalizeRepoDir(config.suitePath ?? DEFAULT_SUITE_PATH)}${docsRoot}`
        : docsRoot;
    this.repositoryRoot = '';
    this.targetBranch = MANAGED_BRANCH;
  }

  static async open(config: SuiteRepositoryConfig): Promise<SuiteRepository> {
    const repository = new SuiteRepository(config);

    try {
      await repository.initialize();
      return repository;
    } catch (error) {
      await repository.dispose();
      throw error;
    }
  }

  get root(): string {
    return this.repositoryRoot;
  }

  get featurePrefix(): string {
    return this.featureRootPrefix.replace(/\/+$/, '');
  }

  get docsPrefix(): string {
    return this.docsRootPrefix.replace(/\/+$/, '');
  }

  get branch(): string {
    return this.targetBranch;
  }

  private authOptions(): { auth?: GitAuth; signal?: AbortSignal } {
    return {
      ...(this.config.auth === null || this.config.auth === undefined
        ? {}
        : { auth: this.config.auth }),
      ...(this.config.signal === undefined ? {} : { signal: this.config.signal }),
    };
  }

  private async initialize(): Promise<void> {
    const dataDir = this.config.dataDir;
    ensureDirectory(dataDir);

    if (this.config.mode === 'managed') {
      await this.initializeManaged(dataDir);
      return;
    }

    const mirrorPath =
      this.config.mode === 'external'
        ? join(dataDir, 'git', 'mirrors', `suite-${this.config.projectId}.git`)
        : join(dataDir, 'git', 'mirrors', `product-${this.config.projectId}.git`);
    const repoUrl =
      this.config.mode === 'external' ? this.config.suiteRepoUrl : this.config.projectRepoUrl;

    if (repoUrl === null || repoUrl === undefined || repoUrl.length === 0) {
      throw new Error(`suiteRepoUrl is required for ${this.config.mode} mode`);
    }

    await syncMirror({
      repoUrl,
      mirrorPath,
      ...this.authOptions(),
    });
    this.mirrorPath = mirrorPath;

    const worktreeParent = this.config.worktreeRoot ?? ensureTmpRoot(dataDir);

    if (this.config.mode === 'external') {
      const resolvedBranch = await resolveDefaultBranch(mirrorPath);
      const defaultBranch = resolvedBranch ?? 'main';
      // 在 addWorktree 前先确认 ref 确实存在；否则 `git worktree add` 会以
      // `fatal: invalid reference` 失败，但预先 mkdtemp 出来的目录会被保留且没有
      // .git，后续 assertWorktreeReady 的 rev-parse 会向上爬到项目仓库根，
      // 报出误导性的 toplevel 错误。常见触发：GitHub 不可达导致 mirror 未曾
      // 成功拉取到任何分支。
      await assertRefExists(mirrorPath, defaultBranch, this.authOptions().auth);
      ensureDirectory(worktreeParent);
      const worktree = mkdtempSync(join(worktreeParent, 'suite-'));
      try {
        await addWorktree({
          mirrorPath,
          worktreePath: worktree,
          ref: defaultBranch,
          ...this.authOptions(),
        });
        // 校验 worktree 真的建成了。若此步失败而不报错，后续 git add/commit
        // 会向上找到外层仓库（例如项目仓库）并误提交。
        await assertWorktreeReady(worktree);
      } catch (error) {
        // 失败时清理预创建目录，避免残留无 .git 的空目录。
        rmWorktreeDirectory(worktree);
        throw error;
      }
      this.worktreePath = worktree;
      this.repositoryRoot = worktree;
      this.targetBranch = defaultBranch;
      return;
    }

    // same_repo：优先使用已有的 gait/ai-tests 分支，否则从目标 commit 起始。
    const branchExists = await runGit(['rev-parse', '--verify', `refs/heads/${SAME_REPO_BRANCH}`], {
      cwd: mirrorPath,
      allowFailure: true,
    });
    const ref =
      branchExists.exitCode === 0
        ? SAME_REPO_BRANCH
        : (this.config.headSha ?? (await resolveCommit(mirrorPath, 'HEAD', this.authOptions())));
    ensureDirectory(worktreeParent);
    const worktree = mkdtempSync(join(worktreeParent, 'product-'));
    try {
      await addWorktree({
        mirrorPath,
        worktreePath: worktree,
        ref,
        ...this.authOptions(),
      });
    } catch (error) {
      rmWorktreeDirectory(worktree);
      throw error;
    }
    this.worktreePath = worktree;
    this.repositoryRoot = worktree;
    this.targetBranch = SAME_REPO_BRANCH;
    this.sameRepoBranch = true;
  }

  private async initializeManaged(dataDir: string): Promise<void> {
    const repoPath = join(dataDir, 'suites', this.config.projectId);
    this.repositoryRoot = repoPath;
    this.targetBranch = MANAGED_BRANCH;

    if (existsSync(join(repoPath, '.git'))) {
      return;
    }

    ensureDirectory(repoPath);
    await runGit(['init', '-b', MANAGED_BRANCH], { cwd: repoPath });
    const bootstrapFiles = [
      'README.md',
      'steps/registry.json',
      ...SUITE_DIRECTORIES.map((directory) => `${directory}/.gitkeep`),
      `${this.featureRootPrefix.replace(/\/+$/, '')}/.gitkeep`,
    ];

    for (const file of bootstrapFiles) {
      const absolute = pathInside(repoPath, file);

      if (existsSync(absolute)) {
        continue;
      }

      ensureDirectory(dirname(absolute));
      writeFileSync(
        absolute,
        file === 'steps/registry.json'
          ? '{\n  "steps": []\n}\n'
          : file === 'README.md'
            ? '# AI Test Suite\n\nGenerated and maintained by git-ai-test-flow.\n'
            : '',
        'utf8',
      );
    }

    await runGit(['add', '-A'], { cwd: repoPath });
    await runGit(['commit', '-m', 'chore: initialize suite repository'], { cwd: repoPath });
  }

  async listFeatureFiles(): Promise<SuiteFeatureFile[]> {
    const prefix = this.featureRootPrefix.replace(/\/+$/, '');
    const root = pathInside(this.repositoryRoot, prefix);

    return walkFeatureFiles(root).map((relativePath) => {
      const path = `${prefix}/${relativePath}`;
      const content = readFileSync(pathInside(this.repositoryRoot, path), 'utf8');

      return { path, content, blobSha: gitBlobSha(content) };
    });
  }

  readFile(relativePath: string): string | null {
    const absolute = pathInside(this.repositoryRoot, relativePath);

    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  }

  async writeAndCommit(
    files: readonly SuiteFileInput[],
    message: string,
  ): Promise<SuiteCommitResult> {
    // 守卫：cwd 必须是真正的仓库根。若 worktree 缺少自己的 .git，
    // git 会向上查到外层仓库（例如项目仓库），导致把用例提交进错误的仓库
    // 并触发外层 husky 钩子。此处显式拦截。
    await this.assertRepositoryRoot();

    if (files.length === 0) {
      const head = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());

      return { commitSha: head, changed: false, committedPaths: [] };
    }

    const prefix = `${this.featureRootPrefix.replace(/\/+$/, '')}/`;

    for (const file of files) {
      if (!file.path.startsWith(prefix) || !file.path.endsWith('.feature')) {
        throw new Error(`Only feature files under ${prefix} may be committed`);
      }

      if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`Feature file is too large: ${file.path}`);
      }

      const absolute = pathInside(this.repositoryRoot, file.path);
      ensureDirectory(dirname(absolute));
      writeFileSync(absolute, file.content, 'utf8');
    }

    await runGit(['add', '-A'], { cwd: this.repositoryRoot, ...this.authOptions() });
    const status = await runGit(['status', '--porcelain'], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });

    if (status.stdout.trim().length === 0) {
      const head = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());

      return { commitSha: head, changed: false, committedPaths: [] };
    }

    await runGit(['commit', '-m', message], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });
    const commitSha = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());
    await this.publish(commitSha);

    return {
      commitSha,
      changed: true,
      committedPaths: files.map((file) => file.path),
    };
  }

  /** 仅暂存 feature 文件，不提交；供自动修复在重跑前应用补丁。 */
  stageFeatureFile(relativePath: string, content: string): void {
    const prefix = `${this.featureRootPrefix.replace(/\/+$/, '')}/`;

    if (!relativePath.startsWith(prefix) || !relativePath.endsWith('.feature')) {
      throw new Error(`Only feature files under ${prefix} may be modified`);
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`Feature file is too large: ${relativePath}`);
    }

    const absolute = pathInside(this.repositoryRoot, relativePath);

    ensureDirectory(dirname(absolute));
    writeFileSync(absolute, content, 'utf8');
  }

  /** 仅暂存 docsRoot 下的 Markdown/modules.yaml，不提交。 */
  stageDocsFile(relativePath: string, content: string): void {
    const prefix = `${this.docsRootPrefix.replace(/\/+$/, '')}/`;
    const allowed =
      (relativePath.startsWith(prefix) && relativePath.endsWith('.md')) ||
      relativePath === `${prefix}modules.yaml`;

    if (!allowed) {
      throw new Error(`Only Markdown documents under ${prefix} may be modified`);
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`Document is too large: ${relativePath}`);
    }

    const absolute = pathInside(this.repositoryRoot, relativePath);

    ensureDirectory(dirname(absolute));
    writeFileSync(absolute, content, 'utf8');
  }

  /** 文档提交：只允许 docsRoot 下的 .md 与 modules.yaml，避免写产品代码。 */
  async writeDocsAndCommit(
    files: readonly SuiteFileInput[],
    message: string,
  ): Promise<SuiteCommitResult> {
    if (files.length === 0) {
      const head = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());

      return { commitSha: head, changed: false, committedPaths: [] };
    }

    const prefix = `${this.docsRootPrefix.replace(/\/+$/, '')}/`;

    for (const file of files) {
      const allowed =
        (file.path.startsWith(prefix) && file.path.endsWith('.md')) ||
        file.path === `${prefix}modules.yaml`;

      if (!allowed) {
        throw new Error(`Only Markdown documents under ${prefix} may be committed`);
      }

      if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`Document is too large: ${file.path}`);
      }

      const absolute = pathInside(this.repositoryRoot, file.path);
      ensureDirectory(dirname(absolute));
      writeFileSync(absolute, file.content, 'utf8');
    }

    await runGit(['add', '-A'], { cwd: this.repositoryRoot, ...this.authOptions() });
    const status = await runGit(['status', '--porcelain'], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });

    if (status.stdout.trim().length === 0) {
      const head = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());

      return { commitSha: head, changed: false, committedPaths: [] };
    }

    await runGit(['commit', '-m', message], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });
    const commitSha = await resolveCommit(this.repositoryRoot, 'HEAD', this.authOptions());
    await this.publish(commitSha);

    return {
      commitSha,
      changed: true,
      committedPaths: files.map((file) => file.path),
    };
  }

  private async publish(commitSha: string): Promise<void> {
    if (this.config.mode === 'managed' || this.mirrorPath === null) {
      return;
    }

    if (this.sameRepoBranch) {
      await runGit(['update-ref', `refs/heads/${this.targetBranch}`, commitSha], {
        cwd: this.mirrorPath,
        ...this.authOptions(),
      });
    }

    // mirror clone 的 origin 带 mirror=true，不能直接带 refspec push；
    // 使用 URL 推送可避开 mirror 语义，同时保留 askpass 认证。
    const remoteUrl = await runGit(['remote', 'get-url', 'origin'], {
      cwd: this.mirrorPath,
      ...this.authOptions(),
    });
    await runGit(['push', remoteUrl.stdout.trim(), `HEAD:refs/heads/${this.targetBranch}`], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });

    if (!this.sameRepoBranch) {
      await runGit(['update-ref', `refs/heads/${this.targetBranch}`, commitSha], {
        cwd: this.mirrorPath,
        ...this.authOptions(),
      });
    }
  }

  /** 确认 cwd 是独立仓库根；否则提交会误伤外层仓库。 */
  private async assertRepositoryRoot(): Promise<void> {
    const result = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: this.repositoryRoot,
      ...this.authOptions(),
    });
    const top = resolve(result.stdout.trim());
    const expected = resolve(this.repositoryRoot);

    if (top !== expected) {
      throw new Error(
        `Suite worktree is not a git repository root (resolved to ${top}); refusing to commit to avoid touching an outer repository`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.mirrorPath !== null && this.worktreePath !== null) {
      await removeWorktree(this.mirrorPath, this.worktreePath);
      this.worktreePath = null;
    }
  }
}

function ensureTmpRoot(_dataDir: string): string {
  // worktree 必须放在外层 git 仓库之外：若放在 data/ 下（项目仓库内部），
  // 一旦 worktree 的 .git 缺失，git 会向上找到外层仓库根，
  // 导致 git add/commit 误伤项目仓库（并触发其 husky 钩子）。
  const root = join(tmpdir(), 'gait-worktrees');
  mkdirSync(root, { recursive: true });

  return root;
}

/**
 * 确认 mirror 中存在指定的 ref。提前校验，避免 `git worktree add` 以
 * `fatal: invalid reference` 失败后留下一个没有 .git 的空目录，进而触发
 * assertWorktreeReady 爬到外层仓库根、报出误导性的 toplevel 错误。
 */
async function assertRefExists(
  mirrorPath: string,
  ref: string,
  auth?: GitAuth | undefined,
): Promise<void> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: mirrorPath,
    allowFailure: true,
    ...(auth === undefined ? {} : { auth }),
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Suite worktree ref "${ref}" does not exist in mirror ${mirrorPath}; ` +
        'the mirror may not have been synced yet (check git proxy / network reachability)',
    );
  }
}

/** 失败时清理预创建的 worktree 目录（此时它尚未注册为 git worktree）。 */
function rmWorktreeDirectory(worktreePath: string): void {
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // 清理失败不掩盖原始错误。
  }
}

/** 确认 worktree 已建立且带有自己的 .git，避免向上污染外层仓库。 */
async function assertWorktreeReady(worktreePath: string): Promise<void> {
  const expected = resolve(worktreePath);
  const result = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: expected,
    allowFailure: true,
  });

  if (result.exitCode !== 0 || resolve(result.stdout.trim()) !== expected) {
    throw new Error(
      `Suite worktree was not created correctly at ${expected} (toplevel=${result.stdout.trim()})`,
    );
  }
}

/** 供索引写入数据库时生成稳定相对路径。 */
export function suiteRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}
