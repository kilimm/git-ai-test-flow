// 本文件所有改动要求遵循 agent-rules 规范
import { expect, test } from '@playwright/test';

const APP_TITLE = 'git-ai-test-flow';

test('loads the web shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(APP_TITLE)).toBeVisible();
});
