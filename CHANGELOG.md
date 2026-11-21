# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [0.3.0] - 2026-11-21

### Added

- SQLite → PostgreSQL 迁移导出（DDL、索引、可选数据、外键拓扑顺序）；`pnpm db:export:postgres`。目标数据库 PostgreSQL 适配器继续可用。
- 环境分组、环境 `groupId`、Run 基线环境 A/B；租户日/并发 Run 与月度 LLM token 配额、用量 API 与 429 阻断。
- CI/PR 集成：GitHub/GitLab 仓库配置、连通性测试、Run 报告评论回写；token 使用 `git_pat` 凭据。
- S3 兼容产物归档：SigV4 PUT/GET/DELETE、Worker 镜像、Server 本地缺失回源；`ARTIFACT_STORAGE=s3`。
- 通用 OIDC SSO：Provider 管理、client secret 加密、state HMAC+Cookie、授权码交换、userinfo、身份绑定与自动成员 provisioning；登录页发现/跳转。
- 多 Runner 注册表与 token 心跳；Worker `RUNNER_NAME`/`RUNNER_MODE`；原子任务领取支持多 Worker。
- `plugin` 类型 step：从 Suite `steps/plugins/*.mjs` 加载，继承脚本沙箱、超时与取消。
- P2 验收报告与部署环境变量文档。

### Security

- OIDC state 使用 SESSION_SECRET HMAC 并绑定 Cookie，防登录 CSRF；provider client secret AES-256-GCM。
- CI token、runner token 不落库明文；S3 使用 SigV4，不引入长期 SDK 凭据到日志。
- 配额限制在 Run 创建前检查；SSO 限制 email domain 与活动成员关系。
- 插件脚本仍只允许 Suite 受版本管理路径，子进程环境白名单。

### Known issues

- 平台元数据库仍是 SQLite；PostgreSQL 是目标库适配与迁移导出，不是平台双后端运行时。
- Runner 环境锁仍是进程内；跨进程多 Runner 同环境并发需部署层约束/后续分布式锁。
- S3、CI、OIDC 未连接真实外部服务；Docker 未在本机启动。
- SSO 依赖 HTTPS 的 OIDC userinfo 响应；未实现 token 撤销/单点登出。

## [0.2.0] - 2026-11-21

### Added

- Midscene 适配器与 `[agent]` UI 步骤：When=aiAct、Then=aiAssert、单步截图；未安装依赖/视觉模型返回 `VISION_UNAVAILABLE`。
- LLM 修复提案、安全 guard、自动应用 + 重跑、Suite 提交；高风险修复审批/拒绝/回滚 API 与 GUI。
- 历史基线环境 `baselineEnvironmentId`、报告基线 A/B 摘要。
- Run/Generation SSE（Last-Event-ID、心跳、终态关闭）与前端 EventSource + 轮询兜底。
- 项目级访问模式（tenant/restricted）、项目成员角色与跨项目资源访问检查。
- Graph C 文档：modules.yaml、T0 提交条目、结构化模块文档、引用 stale 校验、T1-T3 压缩、FTS5、人工编辑冲突保护和 Docs GUI。
- 触发器：Git Webhook、部署回调、Cron 定时；一次性 token（只存 SHA-256）、幂等、Worker 调度、影响面选测。
- P1 验收报告与 M9 文档。

### Security

- Webhook token 使用随机 32 字节 + 一次性明文展示 + SHA-256。
- 文档/修复只允许写入 Suite 的 feature/docs 根目录；路径与大小校验。
- SSE 需要会话认证并继承项目访问限制。

### Known issues

- 真实 Midscene/视觉模型、Docker runner、GitHub/GitLab、真实产品仓库和像素级截图对比未在本开发机验证。
- 自动修复仅覆盖 guard=allowed 的用例补丁；复杂场景仍需人工审批。
- 平台元数据库仍为 SQLite。

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
