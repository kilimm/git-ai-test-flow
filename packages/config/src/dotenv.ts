// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

export const ENV_FILE_NAME = '.env';

/**
 * 从 startDir 开始向上查找最近的 `.env` 并加载。
 * Node 的 `process.loadEnvFile` 不覆盖已有环境变量，因此显式导出的变量优先。
 * 返回加载的文件路径；未找到时返回 undefined。
 */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  let current = startDir;
  const root = parse(current).root;

  for (;;) {
    const candidate = join(current, ENV_FILE_NAME);

    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}
