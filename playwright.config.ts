// 本文件所有改动要求遵循 agent-rules 规范
import { defineConfig, devices } from '@playwright/test';

const WEB_HOST = '127.0.0.1';
const WEB_PORT = 5173;
const WEB_BASE_URL = `http://${WEB_HOST}:${WEB_PORT}`;
const IS_CI = Boolean(process.env.CI);

/**
 * E2E 基线：由 Playwright 自行启动 Vite 开发服务器。
 * M1 只验证 Web 外壳可访问；业务 E2E 随 M7 的 GUI 页面补充。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // 使用完整 Chromium（新无头模式）而不是 headless shell，行为更接近真实浏览器。
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
  webServer: {
    command: `pnpm --filter @gait/web dev --host ${WEB_HOST} --port ${WEB_PORT} --strictPort`,
    url: WEB_BASE_URL,
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
  },
});
