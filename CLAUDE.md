# git-ai-test-flow 开发约定

## 项目定位

AI 驱动的 Git 变更测试平台：从提交差异识别功能点，生成可执行的 Gherkin 用例，在**外部 CI/CD 已部署的测试环境**上完成 API / 数据库 / UI 端到端回归，并做失败归因、修复建议与飞书通知。

**硬约束**：平台不构建、不部署、不启动、不执行产品代码；测试环境由外部 CI/CD 提供，平台只通过 HTTP、浏览器、数据库访问。被测项目语言/框架无关。

## 文档事实源

| 文档 | 用途 |
|---|---|
| `docs/PROJECT_SPEC.md` | 产品设计、架构、数据模型、API、验收标准 |
| `docs/DEVELOPMENT_PLAN.md` | 开发阶段、步骤拆分、依赖、验收标准 |
| `docs/DEVELOPMENT_PROGRESS.md` | 开发进度唯一事实源 |

文档与代码不一致时，先修文档再改代码；代码行为变化必须同步更新对应文档。

## 提交前强制规则

**每次提交前必须更新 `docs/DEVELOPMENT_PROGRESS.md`**：

1. 更新对应 Step 的状态、日期、commit/备注；
2. 重算里程碑进度与总体进度；
3. 更新「最近提交」与「变更日志」；纯文档提交也要登记一行；
4. 进度文档与本次改动放入同一个 commit；
5. commit message 必须包含步骤 ID，例如：
   `feat(m1): 初始化 pnpm workspace [M1-S1]`；
6. 未同步进度文档不得提交。

进度状态：`DONE` / `DOING` / `VERIFY` / `TODO` / `BLOCKED` / `CANCELED`。`VERIFY` 不计入进度，`DONE` 必须有验证结果。

## 开发顺序

按 `docs/DEVELOPMENT_PLAN.md` 的 M0-M10 推进：

- P0 关键路径：M1 工程基座 → M2 认证与租户 → M3 项目与配置 → M4 变更分析与用例生成 → M5 执行引擎 → M6 归因/报告/通知 → M8 验收；
- M7 GUI 从 M2 起并行；
- P1/P2 不提前实现，除非用户明确要求。

每个 Step 的完成定义：代码 + 测试 + 文档 + 进度 + 安全/租户隔离检查 + 验证命令通过。

## 工程约定

- Node.js 22 + TypeScript strict + pnpm workspace。
- 包作用域 `@gait/*`；应用在 `apps/`，共享能力在 `packages/`。
- 依赖方向：`apps → packages/agent → packages/runner → packages/git → packages/db → packages/shared → packages/config`，禁止循环依赖。
- API：Fastify + Zod；错误用 RFC 7807；租户从会话派生，绝不信任请求参数中的 `tenant_id`。
- DB：SQLite + Drizzle + better-sqlite3；WAL、`foreign_keys=ON`、`busy_timeout`；应用库与 LangGraph checkpoint 库分离。
- 凭据：AES-256-GCM，AAD 绑定租户/项目/用途；日志与 API 只出现掩码。
- 测试：Vitest + Playwright Test；核心纯函数覆盖率 ≥ 80%。
- 前端：React + Vite + Tailwind + antd + lucide-react；遵循用户全局前端规范（组件、命名、Tailwind、接口调用）。
- 不提交 `.env`、`data/`、密钥、产物；`.env.example` 只用占位符。

## 常用命令（随实现逐步生效）

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm db:generate
pnpm db:migrate
pnpm admin:create
pnpm check:progress
```
