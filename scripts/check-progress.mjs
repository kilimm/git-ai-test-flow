#!/usr/bin/env node
// 本文件所有改动要求遵循 agent-rules 规范
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PROGRESS_FILE = 'docs/DEVELOPMENT_PROGRESS.md';

/**
 * @typedef {object} Options
 * @property {string | undefined} base 对比的基准 ref；为空时检查暂存区
 * @property {boolean} help 是否输出帮助
 */

/** @param {string[]} args @returns {Options} */
function parseArgs(args) {
  /** @type {Options} */
  const options = { base: undefined, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--base') {
      const value = args[index + 1];

      if (value === undefined || value.startsWith('-')) {
        throw new Error('--base requires a git ref, e.g. --base origin/main');
      }

      options.base = value;
      index += 1;
    } else if (arg.startsWith('--base=')) {
      const value = arg.slice('--base='.length);

      if (value.length === 0) {
        throw new Error('--base requires a git ref, e.g. --base origin/main');
      }

      options.base = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/**
 * @param {string} output
 * @returns {string[]}
 */
function splitLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * @typedef {object} ChangeSet
 * @property {string[]} files 全部改动文件（含删除）
 * @property {boolean} progressUpdated 进度文档是否被新增/修改/重命名
 */

/**
 * 取得需要检查的改动集合。
 * @param {Options} options
 * @returns {ChangeSet}
 */
export function getChangedFiles(options) {
  if (options.base !== undefined) {
    const mergeBase = git(['merge-base', options.base, 'HEAD']).trim();

    return {
      files: splitLines(git(['diff', '--name-only', '--diff-filter=ACMRD', mergeBase, 'HEAD'])),
      progressUpdated:
        git([
          'diff',
          '--name-only',
          '--diff-filter=ACMR',
          mergeBase,
          'HEAD',
          '--',
          PROGRESS_FILE,
        ]).trim().length > 0,
    };
  }

  return {
    files: splitLines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'])),
    progressUpdated:
      git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', PROGRESS_FILE]).trim()
        .length > 0,
  };
}

/**
 * 除进度文档外还有改动、但没有更新进度文档时返回违规文件；否则返回空数组。
 * 仅删除进度文档不算已更新，避免绕过门禁。
 * @param {ChangeSet} changeSet
 * @returns {string[]}
 */
export function findMissingProgressUpdate(changeSet) {
  const otherChanges = changeSet.files.filter((file) => file !== PROGRESS_FILE);

  if (otherChanges.length === 0 || changeSet.progressUpdated) {
    return [];
  }

  return otherChanges;
}

function printHelp() {
  process.stdout.write(
    [
      '用法: pnpm check:progress [--base <ref>]',
      '',
      '默认检查暂存区；--base 改为对比 <ref>...HEAD（用于 CI 的 PR 校验）。',
      `除 ${PROGRESS_FILE} 外存在改动时，必须同时更新并暂存该进度文档。`,
      '',
    ].join('\n'),
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const changeSet = getChangedFiles(options);
  const missing = findMissingProgressUpdate(changeSet);

  if (missing.length > 0) {
    const listed = missing.slice(0, 20).map((file) => `  - ${file}`);
    const more = missing.length > 20 ? [`  ... 另有 ${missing.length - 20} 个文件`] : [];

    process.stderr.write(
      [
        `进度文档未同步：检测到 ${missing.length} 个非进度文档改动，但 ${PROGRESS_FILE} 未更新。`,
        ...listed,
        ...more,
        '',
        `请更新 ${PROGRESS_FILE}（步骤状态、里程碑与总体进度、最近提交、变更日志），`,
        '然后重新暂存后提交。纯文档改动同样需要登记。',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('进度文档检查通过。\n');
}

const invokedPath = process.argv[1];

if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`进度文档检查失败: ${message}\n`);
    process.exitCode = 1;
  }
}
