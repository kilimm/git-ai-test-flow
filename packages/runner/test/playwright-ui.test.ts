// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { PlaywrightUiDriver } from '../src/index.js';

const PAGE = [
  'data:text/html,',
  encodeURIComponent(`
    <html>
      <body>
        <input name="username" />
        <input name="password" type="password" />
        <button type="submit" onclick="document.body.innerText='Dashboard'">Login</button>
      </body>
    </html>
  `),
].join('');

describe('playwright ui driver', () => {
  it('drives a real Chromium page, captures screenshots and trace', async () => {
    let driver: PlaywrightUiDriver;

    try {
      driver = await PlaywrightUiDriver.launch({ headless: true, trace: true });
    } catch (error) {
      // 本地未安装 Chromium 时跳过；CI 的 E2E 作业会安装。
      console.warn(`Chromium unavailable, skipping UI driver test: ${String(error)}`);
      return;
    }

    try {
      await driver.startTrace();
      await driver.goto(PAGE);
      await driver.fill('input[name="username"]', 'admin');
      await driver.fill('input[name="password"]', 'secret');
      await driver.click('button[type="submit"]');
      await driver.waitForLoad();

      expect(await driver.pageText()).toContain('Dashboard');
      expect(await driver.isVisible('body')).toBe(true);
      const screenshot = await driver.screenshot();

      expect(screenshot.byteLength).toBeGreaterThan(100);
      const trace = await driver.stopTrace();

      expect(trace).not.toBeNull();
      expect(trace?.byteLength).toBeGreaterThan(10);
    } finally {
      await driver.close();
    }
  }, 30_000);
});
