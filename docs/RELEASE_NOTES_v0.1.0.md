# git-ai-test-flow v0.1.0

发布日期：2026-11-21

这是 P0 阶段首个可运行版本，目标是把「Git 变更 → Gherkin 用例 → 外部已部署环境回归 → 归因/报告/通知 → GUI 审阅」串成可审计闭环。

## 快速开始

```bash
pnpm install
cp .env.example .env
# 设置 ENCRYPTION_KEY、SESSION_SECRET、PUBLIC_BASE_URL
pnpm db:migrate
ADMIN_PASSWORD='至少 12 位密码' pnpm admin:create --username admin --tenant-slug acme --tenant-name Acme
pnpm --filter @gait/server dev
pnpm --filter @gait/worker dev
pnpm --filter @gait/web dev
```

Docker 部署、备份恢复与升级见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 验收范围

- 自动化：单元/集成测试、Playwright E2E（独立 API + 种子库 + 本地 bare Suite）。
- 安全：跨租户、CSRF、登录限流、API 限流、SSRF、路径越界、产物路径、凭据掩码、prompt injection 不可信分隔、`check:security`。
- 性能：项目列表 API 本机 p95 基线；50 条 API 用例在 M5 验收中完成。
- 外部环境验收：提供 `examples/demo-app` 与 `pnpm smoke:p0`，真实外部 CI/CD 部署需用户环境执行；本开发机没有 Docker 与外部部署环境，未执行真实容器与线上飞书验收。

## 已知问题

1. Docker Compose 未实际启动验证（本机无 Docker）。
2. P0 GUI 使用轮询，非 SSE。
3. 平台元数据仍使用 SQLite 单机模式；多实例与多 runner 扩展在后续里程碑。
4. 外部 LLM/飞书/被测环境由用户配置；自动化测试使用假实现，不覆盖真实供应商差异。
5. `examples/demo-app` 依赖 Node 实验性 `node:sqlite`。
