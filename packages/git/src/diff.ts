// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GIT_EMPTY_TREE_SHA } from '@gait/shared';
import type { CommitInfo, DiffChangeStatus, DiffFile, DiffHunk } from '@gait/shared';
import { ensureDirectory, ensureParentDirectory, runGit } from './command.js';
import type { GitAuth, GitRunResult } from './command.js';

export interface DiffRangeInput {
  repoPath: string;
  baseSha: string;
  headSha: string;
  unified?: number;
  auth?: GitAuth | undefined;
  signal?: AbortSignal;
  maxFiles?: number;
}

export interface CurrentDiffInput {
  repoPath: string;
  unified?: number;
  auth?: GitAuth | undefined;
  signal?: AbortSignal;
  maxFiles?: number;
}

export interface GitDiffResult {
  mode: 'current' | 'range';
  baseSha: string | null;
  headSha: string;
  commits: CommitInfo[];
  files: DiffFile[];
}

interface NameStatusEntry {
  status: DiffChangeStatus;
  path: string;
  oldPath: string | null;
}

const DEFAULT_MAX_FILES = 500;
const COMMIT_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';

export async function resolveCommit(
  repoPath: string,
  ref: string,
  options: { auth?: GitAuth; signal?: AbortSignal } = {},
): Promise<string> {
  const result = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoPath,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return result.stdout.trim();
}

export async function resolveDefaultBranch(repoPath: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--short', 'HEAD'], {
    cwd: repoPath,
    allowFailure: true,
  });

  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function syncMirror(input: {
  repoUrl: string;
  mirrorPath: string;
  auth?: GitAuth | undefined;
  signal?: AbortSignal;
}): Promise<void> {
  const auth = input.auth === undefined ? {} : { auth: input.auth };
  const signal = input.signal === undefined ? {} : { signal: input.signal };

  if (existsSync(`${input.mirrorPath}/HEAD`)) {
    await runGit(['remote', 'update', '--prune'], {
      cwd: input.mirrorPath,
      ...auth,
      ...signal,
    });

    return;
  }

  ensureParentDirectory(input.mirrorPath);
  await runGit(['clone', '--mirror', input.repoUrl, input.mirrorPath], {
    ...auth,
    ...signal,
  });
}

export async function addWorktree(input: {
  mirrorPath: string;
  worktreePath: string;
  ref: string;
  auth?: GitAuth | undefined;
  signal?: AbortSignal;
}): Promise<void> {
  // git 以 mirrorPath 为 cwd 执行 `worktree add`，相对路径会被解析到 mirror 目录下，
  // 导致 worktree 落到别处、后续校验 toplevel 指向外层仓库。统一转绝对路径避免歧义。
  const mirrorPath = resolve(input.mirrorPath);
  const worktreePath = resolve(input.worktreePath);
  ensureDirectory(worktreePath);
  await runGit(['worktree', 'add', '--detach', '--force', worktreePath, input.ref], {
    cwd: mirrorPath,
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

export async function removeWorktree(mirrorPath: string, worktreePath: string): Promise<void> {
  const mirror = resolve(mirrorPath);
  await runGit(['worktree', 'remove', '--force', resolve(worktreePath)], {
    cwd: mirror,
    allowFailure: true,
  });
  await runGit(['worktree', 'prune'], { cwd: mirror, allowFailure: true });
}

export interface RecentCommitsInput {
  repoPath: string;
  /** 起始 ref，默认 HEAD。 */
  ref?: string;
  /** 最多返回条数，默认 50。 */
  limit?: number;
  auth?: GitAuth | undefined;
  signal?: AbortSignal;
}

export async function listCommits(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<CommitInfo[]> {
  const result = await runGit(
    [
      'log',
      `--format=%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%s${COMMIT_SEPARATOR}`,
      `${baseSha}..${headSha}`,
    ],
    { cwd: repoPath },
  );

  return result.stdout
    .split(COMMIT_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', author = '', email = '', timestamp = '0', title = ''] =
        record.split(FIELD_SEPARATOR);

      return {
        sha,
        shortSha: sha.slice(0, 8),
        author,
        email,
        committedAt: Number(timestamp) * 1000,
        title,
      } satisfies CommitInfo;
    });
}

/**
 * 读取仓库最近提交（按提交时间倒序），供前端下拉选择 Head/Base SHA。
 * 与 listCommits（需要 base..head 区间）不同，这里只要一条 ref。
 */
export async function listRecentCommits(input: RecentCommitsInput): Promise<CommitInfo[]> {
  const ref = input.ref ?? 'HEAD';
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const result = await runGit(
    [
      'log',
      `--format=%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%s${COMMIT_SEPARATOR}`,
      '-n',
      String(limit),
      ref,
    ],
    {
      cwd: input.repoPath,
      ...(input.auth === undefined ? {} : { auth: input.auth }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );

  return result.stdout
    .split(COMMIT_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = '', author = '', email = '', timestamp = '0', title = ''] =
        record.split(FIELD_SEPARATOR);

      return {
        sha,
        shortSha: sha.slice(0, 8),
        author,
        email,
        committedAt: Number(timestamp) * 1000,
        title,
      } satisfies CommitInfo;
    });
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const parts = output.split('\0');
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < parts.length) {
    const code = parts[index]?.trim();

    if (code === undefined || code.length === 0) {
      index += 1;
      continue;
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = parts[index + 1] ?? '';
      const newPath = parts[index + 2] ?? '';
      index += 3;

      if (newPath.length === 0) {
        continue;
      }

      entries.push({
        status: code.startsWith('R') ? 'renamed' : 'added',
        path: newPath,
        oldPath: oldPath.length > 0 ? oldPath : null,
      });
      continue;
    }

    const path = parts[index + 1] ?? '';
    index += 2;

    if (path.length === 0) {
      continue;
    }

    const status: DiffChangeStatus = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';

    entries.push({ status, path, oldPath: null });
  }

  return entries;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatchHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of patch.split(/\r?\n/)) {
    const match = HUNK_HEADER.exec(line);

    if (match !== null) {
      if (current !== null) {
        hunks.push(current);
      }

      current = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        content: '',
      };
      continue;
    }

    if (current !== null) {
      current.content += current.content.length === 0 ? line : `\n${line}`;
    }
  }

  if (current !== null) {
    hunks.push(current);
  }

  return hunks;
}

function countChanges(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.content.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}

function patchArgs(
  mode: 'current' | 'range',
  baseSha: string | null,
  headSha: string,
  unified: number,
): string[] {
  const range = mode === 'current' ? ['HEAD'] : [baseSha ?? headSha, headSha];

  return [
    'diff',
    `--unified=${unified}`,
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    ...range,
  ];
}

async function readPatch(
  repoPath: string,
  args: string[],
  entry: NameStatusEntry,
  signal: AbortSignal | undefined,
): Promise<GitRunResult> {
  const paths = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path];

  return runGit([...args, '--', ...paths], {
    cwd: repoPath,
    allowFailure: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function collectFiles(
  repoPath: string,
  mode: 'current' | 'range',
  baseSha: string | null,
  headSha: string,
  unified: number,
  signal: AbortSignal | undefined,
  maxFiles: number,
): Promise<DiffFile[]> {
  const nameStatusArgs = ['diff', '--name-status', '-z', '--find-renames'];
  const args =
    mode === 'current'
      ? [...nameStatusArgs, 'HEAD']
      : [...nameStatusArgs, baseSha ?? headSha, headSha];
  const nameStatus = await runGit(args, {
    cwd: repoPath,
    ...(signal === undefined ? {} : { signal }),
  });
  const entries = parseNameStatus(nameStatus.stdout).slice(0, maxFiles);
  const diffArgs = patchArgs(mode, baseSha, headSha, unified);
  const files: DiffFile[] = [];

  for (const entry of entries) {
    const patchResult = await readPatch(repoPath, diffArgs, entry, signal);
    const patch = patchResult.stdout;
    const binary = patch.includes('Binary files') || patch.includes('GIT binary patch');

    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      category: 'other',
      binary,
      isDoc: false,
      isTest: false,
      isOpenApi: false,
      isSensitive: false,
      skipped: false,
      skipReason: null,
      truncated: false,
      sizeBytes: Buffer.byteLength(patch, 'utf8'),
      ...countChanges(parsePatchHunks(patch)),
      patch,
      hunks: binary ? [] : parsePatchHunks(patch),
    });
  }

  return files;
}

/** 解析 diff 的 base 点：空树与普通提交都可以作为 diff base，但空树不是 commit。 */
async function resolveDiffBase(
  repoPath: string,
  ref: string,
  options: { auth?: GitAuth; signal?: AbortSignal } = {},
): Promise<string> {
  if (ref === GIT_EMPTY_TREE_SHA) {
    return GIT_EMPTY_TREE_SHA;
  }

  return await resolveCommit(repoPath, ref, options);
}

export async function collectRangeDiff(input: DiffRangeInput): Promise<GitDiffResult> {
  const unified = input.unified ?? 3;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  // 空树（baseline 快照）没有 commit 语义，不能走 `^{commit}` 解析。
  const baseSha = await resolveDiffBase(input.repoPath, input.baseSha, {
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const headSha = await resolveCommit(input.repoPath, input.headSha, {
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  // 空树不是 commit：`git log empty..head` 等价于整条历史，对 baseline 无意义，跳过。
  const commits =
    baseSha === GIT_EMPTY_TREE_SHA ? [] : await listCommits(input.repoPath, baseSha, headSha);
  const files = await collectFiles(
    input.repoPath,
    'range',
    baseSha,
    headSha,
    unified,
    input.signal,
    maxFiles,
  );

  return { mode: 'range', baseSha, headSha, commits, files };
}

/**
 * 全仓库快照：以空树为 base、目标提交为 head 的 range diff。
 * 用于 baseline 生成（产品仓库 diff 为空时，对代码库现状做一次全量分析）。
 * 注意：文件数受 maxFiles 限制，超出部分不会出现在 files 中，只是会表现为总数被截断，
 * 调用方应把 baseSha/headSha 与文件数写入 stats 以便提示用户。
 */
export async function collectSnapshotDiff(
  input: Omit<DiffRangeInput, 'baseSha'>,
): Promise<GitDiffResult> {
  return await collectRangeDiff({ ...input, baseSha: GIT_EMPTY_TREE_SHA });
}

/** current 模式需要真实工作区（worktree），用于分析未提交变更。 */
export async function collectCurrentDiff(input: CurrentDiffInput): Promise<GitDiffResult> {
  const headResult = await runGit(['rev-parse', '--verify', 'HEAD'], {
    cwd: input.repoPath,
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const headSha = headResult.stdout.trim();
  const files = await collectFiles(
    input.repoPath,
    'current',
    null,
    headSha,
    input.unified ?? 3,
    input.signal,
    input.maxFiles ?? DEFAULT_MAX_FILES,
  );

  return { mode: 'current', baseSha: null, headSha, commits: [], files };
}
