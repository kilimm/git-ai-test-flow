// 本文件所有改动要求遵循 agent-rules 规范
import { defineConfig, devices } from '@playwright/test';

const WEB_HOST = '127.0.0.1';
const WEB_PORT = 5173;
const WEB_BASE_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const API_PORT = 3100;
const API_BASE_URL = `http://${WEB_HOST}:${API_PORT}`;
const IS_CI = Boolean(process.env.CI);

// Vite 代理在 E2E 中指向独立测试 API，避免污染开发库。
process.env['GAIT_API_TARGET'] = API_BASE_URL;

/**
 * E2E 使用独立测试库与本地 Git 仓库：
 * - API 启动前先构建并写入种子数据（两个租户、生成草稿、失败 Run）；
 * - Web 通过 GAIT_API_TARGET 代理到 3100；
 * - 不依赖外部 LLM、网络或已部署产品环境。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // 使用完整 Chromium（新无头模式）而不是 headless shell，行为更接近真实浏览器。
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  webServer: [
    {
      command: 'pnpm exec tsc -b && pnpm exec tsx e2e/support/start-server.ts',
      url: `${API_BASE_URL}/healthz`,
      reuseExistingServer: !IS_CI,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @gait/web dev --host ${WEB_HOST} --port ${WEB_PORT} --strictPort`,
      url: WEB_BASE_URL,
      reuseExistingServer: !IS_CI,
      timeout: 120_000,
    },
  ],
});
