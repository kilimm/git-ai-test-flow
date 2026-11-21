# P2 验收报告（0.3.0）

日期：2026-11-21
范围：开发计划 M10-S1 ~ M10-S7、规格 22.1 P2 退出标准。

## 1. 验收环境

- Node.js 22、pnpm 10、Windows 11；Vitest/Playwright。
- PostgreSQL 未连接真实实例；验证 PostgreSQL **目标库适配器**与 SQLite → PostgreSQL DDL/数据导出。
- S3 使用注入 fetch 验证 SigV4 请求；未连接真实对象存储。
- CI/PR 集成使用注入 HTTP 客户端验证 GitHub/GitLab 评论请求；未调用真实 GitHub/GitLab。
- OIDC 使用注入 token/userinfo 响应验证授权码流程；未接入真实 IdP。
- Docker 未安装，未启动容器。

## 2. 功能结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | PostgreSQL 迁移工具 | 通过 | `exportPostgresSql` 生成 schema/索引/数据；`pnpm db:export:postgres --out ... [--data]`；测试验证大写/外键/bytea/转义和拓扑顺序 |
| 2 | PostgreSQL 目标库 | 通过（注入驱动） | M5 起 MySQL/PostgreSQL/SQLite 目标库适配；M10 未将平台元数据库迁移到 PostgreSQL |
| 3 | 多环境管理 | 通过 | `environment_groups` 表/API；环境 `groupId`；Run `baselineEnvironmentId` 与 A/B 报告 |
| 4 | 配额与用量 | 通过 | `tenant_quotas`；并/日 Run、月度 LLM token 限制；`GET/PATCH /tenants/:id/quota` 返回用量；Run 创建超限返回 429 |
| 5 | CI/PR 集成 | 通过（注入） | `ci_integrations` CRUD、连通性测试、GitHub issue comment/GitLab MR note 回写；审计 token 不落库 |
| 6 | S3 对象存储 | 通过（注入） | 无 AWS SDK 的 SigV4 PUT/GET/DELETE；Worker 归档 `storage=s3` + metadata `s3Key`；Server 本地缺失时回源 |
| 7 | SSO | 通过（注入 OIDC） | Provider CRUD、加密 client secret、state HMAC + Cookie、授权码交换、userinfo、身份绑定、自动成员 provisioning、会话 Cookie；登录页 SSO 发现入口 |
| 8 | 多 Runner | 通过（注册/心跳） | `runner_nodes` + 一次性 token（只存哈希）；Worker `RUNNER_NAME` 心跳；队列原子领取支持多 Worker；环境锁仍为进程内 |
| 9 | 插件化 step | 通过 | `steps/registry.json` 新增 `plugin` 类型，从 `steps/plugins/<name>.mjs` 加载；子进程白名单环境、超时/取消 |
| 10 | P2 验收 | 通过（含已知约束） | 本报告；SQLite 平台运行时、进程内环境锁与真实云服务需部署环境补验 |

## 3. 指标与约束

- 多 Worker 共用 SQLite 写锁与原子 `UPDATE ... RETURNING` 领取；单机 P2 可水平增加 Worker，但高并发写仍受 SQLite 限制。
- 环境互斥锁在进程内，多 Runner 跨进程同时跑同一环境仍需部署层串行或后续分布式锁；已记录为遗留问题。
- 平台元数据库仍为 SQLite；PostgreSQL 交付的是目标库适配与迁移导出工具，不是双后端运行时。
- S3、CI、OIDC、Docker 均未连接真实外部服务，未伪造线上通过。

## 4. 质量门禁

见 `docs/DEVELOPMENT_PROGRESS.md` M10 验收记录：全量单测、覆盖率、lint、format、typecheck、build、依赖边界、安全扫描、E2E 与 audit:prod。

## 5. 结论

M10 功能、API、数据库迁移、登录 SSO 入口、验收记录完成。受 SQLite 运行时、进程内环境锁与真实云服务环境限制，部分能力以可验证的适配器/导出工具交付，已在已知问题中明确。
