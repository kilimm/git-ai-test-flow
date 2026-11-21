# P0 验收报告（v0.1.0）

日期：2026-11-21
范围：规格 21.2 / 21.3、开发计划第 6 节。

## 1. 验收环境

- 开发机：Windows 11、Node.js 22、pnpm 10。
- 自动化：Vitest 单测/集成测试、Playwright E2E（独立 API 3100 + Vite 5173 + `data/e2e`）。
- 外部依赖：测试使用假 LLM HTTP 服务、假 Webhook、本地 bare Git Suite；不依赖真实模型、真实飞书或外部产品部署。
- 容器：本机未安装 Docker，Compose 未实际启动；配置、镜像与运维文档已交付，部署演练需在部署机补做。
- 外部 demo 环境：未提供真实 CI/CD 部署地址，`pnpm smoke:p0` 未对线上环境执行。

## 2. P0 场景逐项结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 登录、租户切换、RBAC、成员管理；跨租户 404 | 通过 | `apps/server/test/auth|members|security`，Playwright `gui.spec` |
| 2 | 项目、Git/LLM/环境/飞书配置；密钥掩码 | 通过 | `projects|credentials|llm-profiles|environments|notification-channels|config-security` 测试 |
| 3 | current/range diff 与过滤规则 | 通过 | `packages/git/test/diff.test.ts`、`filter` 黄金用例（M4 验收） |
| 4 | 3 个提交生成 ≥10 场景且 100% 校验通过 | 通过 | M4 验收记录；`packages/agent/test/acceptance.test.ts` |
| 5 | 审批提交 Suite，重复生成不重复 | 通过 | `generations.test.ts`、`suite-repository.test.ts` |
| 6 | 外部已部署环境执行历史 + 新增用例，记录 deployedSha | 通过（本地假环境） | `run-executor`、`verify-environment`、`run-handler` 测试；真实外部环境待部署 |
| 7 | 版本不一致标记/严格阻断 | 通过 | `verify-environment.test.ts`、Run 报告字段测试 |
| 8 | 环境不可达快速失败并归因 env_issue | 通过 | `run-executor`、`attribution-rules` 测试 |
| 9 | API 用例校验数据库；三库造数 | 通过 | `db.test.ts`、`db-steps.test.ts`；MySQL/PostgreSQL 使用注入驱动 |
| 10 | 基础 UI 用例有截图/Trace | 通过 | `playwright-ui.test.ts`（真实 Chromium） |
| 11 | code_bug 不自动改测试 | 通过 | `attribution-guard`、`attribution-analyze` 测试 |
| 12 | test_bug 有过时选择器修复建议 | 通过 | `attribution-rules`、`attribution-guard` 测试；P0 仅建议 |
| 13 | 报告可追溯；飞书幂等 | 通过（假 Webhook） | `notify.test.ts`、报告格式测试；真实飞书待配置验收 |
| 14 | 平台不执行产品仓库命令 | 通过 | `pnpm check:security` + 源码扫描 |
| 15 | 安全测试（跨租户/SSRF/路径/凭据/prompt injection/CSRF/限流/安全头） | 通过 | `security.test.ts`、`hardening.test.ts`、`config-security.test.ts`、`attribution` prompt 分隔测试 |
| 16 | Docker Compose 可启动；备份/恢复演练 | 部分通过 | 备份/恢复自动化测试通过；Compose 未实际启动（本机无 Docker） |
| 17 | 发布 v0.1.0、CHANGELOG/已知问题 | 通过 | `CHANGELOG.md`、本报告、tag `v0.1.0` |

## 3. 指标

| 指标 | 目标 | 结果 | 说明 |
|---|---:|---:|---|
| 生成可执行率 | ≥80% | 100% | M4 生成验收；StepRegistry 干跑 |
| 新增功能点覆盖率 | ≥70% | 人工抽查通过 | 生成任务功能点与场景映射 |
| 归因准确率 | ≥75% | 规则矩阵单测通过 | 真实样本准确率需生产数据持续评估 |
| 误修复率 | ≤2% | P0 无自动修复 | 仅建议且 guard=human_required |
| 跨租户越权 | 100% 拦截 | 100% | 多模块集成测试 |
| 关键 API p95 | ≤500ms | 通过 | `performance.test.ts`（本机 SQLite 基线） |
| 50 条 API 回归 | ≤15 分钟 | 通过 | M5 验收记录（本机假环境） |
| 每次 Run 记录部署版本 | 100% | 100% | `deployed_sha` 字段与报告 |
| 环境不可达快速失败 | 100% | 100% | 环境校验用例 |

## 4. 未完成/需外部环境补验

1. **真实外部 CI/CD 部署 demo-app**：源码、Dockerfile、参考部署工作流已提供；平台不负责部署。部署后运行：
   ```bash
   DEMO_BASE_URL=https://demo.example.com DEMO_DEPLOYED_SHA=<sha> pnpm smoke:p0
   ```
2. **Docker Compose 启动演练**：需在安装 Docker 的机器执行 `docker compose up -d --build`，验证 API `/readyz`、Worker 心跳、Web 反向代理与数据卷权限。
3. **真实飞书卡片送达**：需配置真实 Webhook/Secret 并人工确认手机可读与深链。
4. **真实 LLM 供应商**：生成/归因测试使用假客户端；需在项目 LLM Profile 上执行连通性测试与小样本回归。
5. **真实 MySQL/PostgreSQL 实例**：适配器经注入驱动测试，需连接实际测试库执行造数与断言。

## 5. 结论

P0 代码、自动化测试、GUI、报告、通知、部署资料与 v0.1.0 发布物已完成。内部可自动验证的场景全部通过；外部部署、真实供应商与容器启动属于部署环境验收项，已提供脚本与操作手册，未在本开发机伪造通过结果。
