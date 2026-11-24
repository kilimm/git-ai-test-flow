// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { CaseFile } from './case-store.js';

export interface MaterializeResult {
  root: string;
  fileCount: number;
  cleanup: () => void;
}

/** 路径安全：不允许越出 root，也不允许绝对路径。 */
function safeJoin(root: string, relativePath: string): string {
  const normalized = normalize(relativePath).replace(/^([/\\])+/, '');
  const absolute = resolve(root, normalized);

  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`Case file path escapes root: ${relativePath}`);
  }

  return absolute;
}

/**
 * 把 DB 中的用例写到临时目录，供 runner 按路径读取。
 *
 * 目录放在系统临时目录（仓库之外），避免被外层 git 仓库误识别；
 * 调用方用完必须执行 cleanup()。
 */
export function materializeCaseFiles(files: readonly CaseFile[]): MaterializeResult {
  const root = mkdtempSync(join(tmpdir(), 'gait-cases-'));

  try {
    for (const file of files) {
      const absolute = safeJoin(root, file.path);

      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.content, 'utf8');
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }

    cleaned = true;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败不影响主流程。
    }
  };

  return { root, fileCount: files.length, cleanup };
}
