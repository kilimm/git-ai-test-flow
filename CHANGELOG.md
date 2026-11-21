# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.1.0] - 2026-11-21

首个 P0 可用版本：从 Git 变更生成 Gherkin 用例，在外部已部署环境执行 API/DB/UI 回归，完成归因、报告、飞书通知与 GitHub 风格 GUI。

### Added

- 多租户登录、会话、CSRF、RBAC、成员管理与审计。
- 项目、Git 凭据、LLM Profile、Environment Profile、飞书渠道配置；密钥 AES-256-GCM 加密与掩码。
- Git mirror/worktree、current/range diff、文件过滤、功能点提取、Gherkin 生成、StepRegistry 校验、人工审批与 Suite 提交。
- Run 工作区、环境健康/版本校验、SQLite/MySQL/PostgreSQL 造数与断言、HTTP 执行、Playwright UI、并发/超时/取消、产物采集。
- 证据包、规则与 LLM 归因、失败重跑 flaky、修复 guard、JSON/Markdown/HTML/JUnit 报告、飞书签名通知与幂等。
- Web GUI：登录、租户切换、项目配置、生成审批、运行详情、证据/截图、用例索引、审计。
- Playwright E2E 使用独立 API、测试库与本地 bare Suite。
- `examples/demo-app`：由外部 CI/CD 部署的示例产品，包含登录、帖子 API/UI、版本接口与故意缺陷。
- 安全响应头、API 限流、`/readyz`、平台管理员 `/api/v1/metrics`、`check:security` 源码扫描。
- SQLite 在线备份/恢复 CLI、Docker API/Worker/Web 镜像与 Compose、Nginx 配置、部署/恢复/升级文档。
- `pnpm smoke:p0` 外部 demo 环境冒烟脚本。

### Security

- API 默认拒绝私网/元数据地址，内网环境需 `SSRF_ALLOWLIST`。
- 凭据与 Webhook 只返回掩码；子进程不继承平台主密钥。
- CSP、`X-Frame-Options: DENY`、`nosniff`、Referrer-Policy 与生产 HSTS。
- 生产数据库默认拒绝；危险写模式需二次确认。
- 平台不执行产品仓库 install/build/start/test。

### Known issues

- Docker Compose 未在本次开发环境实际启动（本机无 Docker），需在部署机完成一次演练。
- GUI 使用轮询，SSE 与在线编辑在 P1 提供。
- 平台元数据库仍为 SQLite；多实例共享限流/锁未实现。
- 示例 demo 应用使用 Node 实验性 `node:sqlite`，部署时会输出 ExperimentalWarning。
- 真实外部 CI/CD 部署与飞书真实卡片需在用户环境中验收；自动化测试使用假 LLM、假 Webhook 与本地 Git。
