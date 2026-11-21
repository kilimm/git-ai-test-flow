// 本文件所有改动要求遵循 agent-rules 规范
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PASSWORD = 'E2E-Password-123';

async function login(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('username').fill(username);
  await page.getByPlaceholder('至少 12 位').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/t\/[a-z-]+\/projects/, { timeout: 15_000 });
}

test('登录、项目列表与环境配置闭环', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('username').fill('e2e-owner');
  await page.getByPlaceholder('至少 12 位').fill('wrong-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Invalid username or password')).toBeVisible();

  await page.getByPlaceholder('至少 12 位').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/t\/acme\/projects/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Acme E2E' })).toBeVisible();
  await expect(page.getByText('Demo App')).toBeVisible();

  await page.getByText('Demo App').click();
  await expect(page.getByRole('heading', { name: '项目概览' })).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('tab', { name: '环境' }).click();
  await expect(page).toHaveURL(/\/settings\/environments$/);

  await page.getByRole('button', { name: '新建环境' }).click();
  await page.getByLabel('环境名称').fill('e2e-env');
  await page.getByLabel('API Base URL').fill('http://127.0.0.1:3100');
  await page.getByLabel('健康检查 URL').fill('http://127.0.0.1:3100/healthz');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('e2e-env')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('环境已创建')).toBeVisible();
});

test('生成审批、运行证据、用例与审计页面', async ({ page }) => {
  await login(page, 'e2e-owner');

  await page.goto('/t/acme/p/demo/changes');
  await expect(page.getByRole('heading', { name: '变更与生成' })).toBeVisible();
  await page.locator('.ant-list-item').first().click();
  await expect(page.getByText('帖子列表分页')).toBeVisible();
  await expect(page.getByText('features/api/posts.feature', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '批准并提交' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '批准并提交' }).click();
  await expect(page.getByText(/已提交 Suite|草稿无变化/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('已提交').first()).toBeVisible({ timeout: 15_000 });

  await page.goto('/t/acme/p/demo/runs/run-e2e-failed');
  await expect(page.getByRole('heading', { name: /Run run-e2e/ })).toBeVisible();
  await expect(page.getByText('代码缺陷').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'MARKDOWN', exact: true })).toBeVisible();
  await expect(page.getByText('list posts')).toBeVisible();

  await page.getByText('list posts').click();
  await expect(page.getByText('根因')).toBeVisible();
  await expect(page.getByText('分页参数为空时接口返回 500')).toBeVisible();
  await expect(page.getByText('src/api/posts.ts:42', { exact: true })).toBeVisible();
  await expect(page.getByText('重跑仍失败')).toBeVisible();
  await expect(page.getByRole('link', { name: '截图' })).toBeVisible();

  await page.goto('/t/acme/p/demo/tests');
  await expect(page.getByRole('heading', { name: '用例索引' })).toBeVisible();
  await expect(page.getByText('list posts')).toBeVisible();
  await expect(page.getByText('features/api/posts.feature', { exact: true })).toBeVisible();

  await page.goto('/t/acme/p/demo/docs');
  await expect(page.getByRole('heading', { name: '项目文档' })).toBeVisible();
  await expect(page.getByText('帖子模块').first()).toBeVisible();
  await expect(page.getByText('帖子列表、分页与创建接口。').first()).toBeVisible();

  await page.goto('/t/acme/audit');
  await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();
  await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 15_000 });
});

test('文档、项目访问与触发器页面', async ({ page }) => {
  await login(page, 'e2e-owner');

  await page.goto('/t/acme/p/demo/docs');
  await expect(page.getByText('帖子模块').first()).toBeVisible();
  await expect(page.getByText('T0 提交条目（最近 100 条）')).toBeVisible();

  await page.goto('/t/acme/p/demo/settings/access');
  await expect(page.getByRole('heading', { name: '项目访问' })).toBeVisible();
  await expect(page.getByText('项目成员只用于限制访问，不会扩大租户角色已有的权限')).toBeVisible();

  await page.goto('/t/acme/p/demo/settings/triggers');
  await page.getByRole('button', { name: '新建触发器' }).click();
  await page.getByLabel('名称').fill('e2e-deploy');
  await page.locator('.ant-modal').getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('触发器 token')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByText('e2e-deploy', { exact: true })).toBeVisible();
  await expect(page.getByText('deployment').first()).toBeVisible();
});

test('跨租户访问隔离与只读角色 UI', async ({ page }) => {
  await login(page, 'e2e-beta');
  await expect(page.getByText('Beta App')).toBeVisible();
  await expect(page.getByText('Demo App')).toHaveCount(0);

  await page.goto('/t/acme/p/demo/overview');
  await expect(page).toHaveURL(/\/t\/beta\/projects$/, { timeout: 15_000 });
  await expect(page.getByText('Demo App')).toHaveCount(0);

  await page.getByRole('button', { name: /用户菜单/ }).click();
  await page.getByText('退出登录').click();
  await expect(page).toHaveURL(/\/login/);

  await login(page, 'e2e-viewer');
  await expect(page.getByText('Demo App')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建项目' })).toHaveCount(0);

  await page.getByText('Demo App').click();
  await expect(page.getByRole('heading', { name: '项目概览' })).toBeVisible();
  await page.getByRole('link', { name: '设置' }).click();
  await page.getByRole('tab', { name: '项目访问' }).click();
  await expect(page.getByText('当前项目角色为只读，不能管理访问配置。')).toBeVisible();

  await page.goto('/t/acme/p/demo/runs');
  await expect(page.getByRole('button', { name: '创建运行' })).toHaveCount(0);
  await page.goto('/t/acme/p/demo/changes');
  await expect(page.getByRole('button', { name: '新建生成任务' })).toHaveCount(0);
});
