// 本文件所有改动要求遵循 agent-rules 规范
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

/**
 * 测试直接使用 workspace 源码，避免依赖先执行 tsc -b 生成的 dist。
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@gait\/db\/testing$/,
        replacement: sourcePath('./packages/db/src/testing.ts'),
      },
      { find: /^@gait\/agent$/, replacement: sourcePath('./packages/agent/src/index.ts') },
      { find: /^@gait\/config$/, replacement: sourcePath('./packages/config/src/index.ts') },
      { find: /^@gait\/db$/, replacement: sourcePath('./packages/db/src/index.ts') },
      { find: /^@gait\/docs$/, replacement: sourcePath('./packages/docs/src/index.ts') },
      { find: /^@gait\/git$/, replacement: sourcePath('./packages/git/src/index.ts') },
      { find: /^@gait\/runner$/, replacement: sourcePath('./packages/runner/src/index.ts') },
      { find: /^@gait\/shared$/, replacement: sourcePath('./packages/shared/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
  },
});
