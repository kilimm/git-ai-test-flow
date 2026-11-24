# 项目配置手册

> 适用范围：git-ai-test-flow 0.3.0。本文说明平台进程配置、租户/项目配置、执行环境、Suite、通知、触发器、CI、SSO、配额与 Runner 的完整配置方式。
>
> 部署步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)；产品字段与安全规则见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。

## 1. 配置层级

| 层级 | 存储位置 | 生效方式 | 典型内容 |
|---|---|---|---|
| 进程环境变量 | `.env` / 部署平台环境变量 | 进程启动时读取，修改后需重启 | 密钥、端口、数据库连接串、S3、Worker |
| 租户配置 | PostgreSQL `tenants` / `tenant_quotas` | 运行时即时生效 | 租户名称、配额、SSO Provider |
| 项目配置 | PostgreSQL `projects` + Suite Git | 运行时即时生效 | 仓库、Suite 模式、访问模式、文档目录 |
| 凭据/LLM/环境/通知/触发器 | PostgreSQL 配置表 | 运行时即时生效 | 被测环境、模型、Webhook、CI |
| Suite 配置 | Suite Git 仓库 | Run 发现用例时读取 | `features/`、`steps/registry.json`、fixtures |
| 运行参数 | Run 记录 | 每次 Run 独立 | base/head SHA、环境、用例选择 |

配置修改优先在 GUI 的「设置」页完成。API 示例均假设已登录并携带 `gait_session` Cookie 与 `X-CSRF-Token` 头；所有写操作写在审计日志中。

## 2. 进程环境变量

变量由 `packages/config/src/env.ts` 校验；非法配置会阻止进程启动。

### 2.1 必填

| 变量 | 说明 |
|---|---|
| `ENCRYPTION_KEY` | 32 字节 Base64 主密钥，用于 AES-256-GCM 凭据加密；缺失或长度错误启动失败 |
| `ENCRYPTION_KEY_VERSION` | 密钥版本，默认 `1`，写入密文记录；轮换前需保留旧密钥解密能力 |
| `SESSION_SECRET` | 至少 32 字符，用于会话/CSRF 辅助签名；缺失启动失败 |
| `PUBLIC_BASE_URL` | 平台 Web 外部地址，用于报告深链、SSO 回调默认基址与飞书卡片链接；必须 http/https |

生成方式：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" # ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))" # SESSION_SECRET
```

### 2.2 运行时与数据

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production`；生产 Cookie 使用 Secure、启用 HSTS |
| `PORT` | `3000` | API 监听端口 |
| `DATA_DIR` | `./data` | 工作区、产物、mirror、Suite 数据根目录 |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/gait` | 平台业务库；必须是 `postgres://` 或 `postgresql://` |
| `CHECKPOINT_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/gait_checkpoints` | LangGraph checkpoint 库；必须指向与业务库不同的数据库 |
| `LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace/silent` |
| `SSRF_ALLOWLIST` | 空 | 允许访问的内网测试主机，逗号分隔；支持 `*.example.internal` |

数据目录建议独立挂载并只允许运行用户读写。`DATABASE_URL` 与 `CHECKPOINT_DATABASE_URL` 相同（或 host/port/database 相同）会被配置校验与 Worker 启动校验拒绝。

### 2.3 安全与网络

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SSO_CALLBACK_BASE_URL` | `${PUBLIC_BASE_URL}/api/v1` | OIDC 回调基地址；API 独立域名时设置 |
| `ARTIFACT_STORAGE` | `local` | `local` / `s3`；S3 为本地文件副本外的归档 |
| `S3_ENDPOINT` | 空 | S3 兼容端点，启用 S3 时必填 |
| `S3_BUCKET` | 空 | 产物 bucket |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_ACCESS_KEY_ID` | 空 | S3 access key；只从环境变量注入 |
| `S3_SECRET_ACCESS_KEY` | 空 | S3 secret；不写库、不写日志 |
| `S3_PATH_STYLE` | `true` | `true` 路径风格；部分云厂商需要关闭 |

### 2.4 Runner / Worker

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RUNNER_CONCURRENCY` | `2` | Runner 并发提示上限；实际执行并发由环境的 API/UI 并发控制 |
| `RUNNER_MODE` | `local` | `local` / `container`，写入 Worker 日志与运行标记 |
| `RUNNER_NAME` | 空 | 与平台 Runner 注册表中的名称一致；设置后写 `runner_nodes` 心跳 |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Worker 队列轮询间隔 |
| `WORKER_LEASE_MS` | `30000` | 任务租约时长 |
| `WORKER_HEARTBEAT_MS` | `10000` | 租约续期间隔，必须小于 `WORKER_LEASE_MS` |

凭据明文、数据库路径、`ENCRYPTION_KEY`、`SESSION_SECRET` 不会注入 Suite 脚本或 Git 子进程。Worker 使用 Playwright 时需按镜像说明提供浏览器，可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定。

### 2.5 配置加载

API/Worker 会自动从当前目录向上查找 `.env`；Docker 通过 compose 注入环境变量。生产建议使用部署平台的 Secret 管理，不把真实 `.env` 复制到镜像。

## 3. 首个管理员与租户

首次部署后执行：

```bash
ADMIN_PASSWORD='至少 12 位密码' pnpm admin:create \
  --username admin \
  --tenant-slug acme \
  --tenant-name "Acme"
```

- 创建平台管理员并同时创建租户、授予 OWNER。
- 已存在平台管理员或用户名被占用时拒绝重复创建，命令不会回显密码。
- 不开放匿名注册；后续成员由 OWNER/ADMIN 在「成员」页添加。
- 首个管理员登录后可在顶部切换租户；会话的 `activeTenantId` 只允许活动成员关系。

## 4. 角色、项目访问与权限

### 4.1 租户角色

| 权限点 | Owner | Admin | Developer | Viewer |
|---|:---:|:---:|:---:|:---:|
| 租户读取 | ✓ | ✓ | ✓ | ✓ |
| 租户更新 / 项目删除 | ✓ |  |  |  |
| 成员管理 | ✓ | ✓ |  |  |
| 项目创建/更新 | ✓ | ✓ |  |  |
| 凭据读取/写入 | ✓ | ✓ |  |  |
| 环境 / LLM / 通知配置 | ✓ | ✓ |  |  |
| 生成 / 运行 / 取消 | ✓ | ✓ | ✓ |  |
| 修复审批 | ✓ | ✓ |  |  |
| 文档编辑 | ✓ | ✓ | ✓ |  |
| 审计读取 | ✓ | ✓ |  |  |

### 4.2 项目级访问模式

项目默认 `accessMode=tenant`：租户成员按租户 RBAC 访问。设置为 `restricted` 后，只有 OWNER/ADMIN 或项目成员可访问；非项目成员访问项目及其运行/生成/文档资源统一返回 404。

```http
PATCH /api/v1/projects/:id/access
Content-Type: application/json

{"accessMode":"restricted"}
```

项目成员不提升租户权限，只进一步限制访问：

```http
POST /api/v1/projects/:id/members
{"username":"alice","role":"developer"}
```

角色：`viewer`（只读）、`developer`（生成/运行/文档）、`admin`（项目内最高访问级别）。项目角色只限制、不提升租户权限；成员/访问策略的增删改仍要求租户 `project:update`（通常 OWNER/ADMIN）。租户 OWNER/ADMIN 始终拥有项目访问权。

## 5. 项目配置

### 5.1 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 1-100 字符 |
| `slug` | 是 | 租户内唯一，2-40 位小写字母/数字/连字符 |
| `productRepoUrl` | 是 | 被测产品 HTTPS 仓库地址 |
| `defaultBranch` | 是 | 有效 Git 分支名 |
| `gitCredentialId` | 私有仓库必填 | `git_pat` 凭据 ID |
| `suiteMode` | 是 | `managed` / `external` / `same_repo` |
| `suiteRepoUrl` | external 必填 | 独立 Suite 仓库 HTTPS 地址 |
| `suitePath` | same_repo 可选 | 默认 `.ai-test/` |
| `featureRoot` | 默认 `features/` | Suite 中 feature 根目录 |
| `docsRoot` | 默认 `docs/ai/` | 文档根目录 |
| `settings` | 可选 | 不超过 10 KB 的 JSON 对象 |

### 5.2 Suite 模式

| 模式 | 行为 | 约束 |
|---|---|---|
| `managed` | 平台在 `DATA_DIR/suites/<projectId>` 初始化本地 Git 仓库 | 不要求产品仓写权限 |
| `external` | 镜像 `suiteRepoUrl`，提交后推送默认分支 | 远端空仓需先有初始提交；需 Git 写权限 |
| `same_repo` | 在产品仓 mirror 上使用 `gait/ai-tests` 分支 | 需产品仓写权限；不触碰默认分支 |

路径配置禁止绝对路径、盘符、反斜杠、`.`/`..` 段与控制字符。平台只写 Suite 的 feature/docs 允许目录，不修改产品代码。

### 5.3 创建示例

```http
POST /api/v1/tenants/:tenantId/projects
Content-Type: application/json

{
  "name": "Demo App",
  "slug": "demo",
  "productRepoUrl": "https://github.com/acme/demo.git",
  "defaultBranch": "main",
  "gitCredentialId": "cred-xxx",
  "suiteMode": "external",
  "suiteRepoUrl": "https://github.com/acme/demo-tests.git",
  "featureRoot": "features/",
  "docsRoot": "docs/ai/"
}
```

## 6. 凭据配置

凭据属于租户，可跨项目复用。四种类型：

| 类型 | 用途 | 额外要求 |
|---|---|---|
| `git_pat` | Git HTTPS、CI 评论 token | 用户名可选；支持测试连接 |
| `llm_api_key` | LLM Profile API Key | 由 LLM 配置引用 |
| `test_account` | UI 登录账号 | `username` + secret 为密码 |
| `db_password` | 测试数据库密码 | 由环境配置引用 |

```http
POST /api/v1/projects/:projectId/credentials
{"name":"git-pat","type":"git_pat","username":"x-access-token","secret":"ghp_xxx"}

POST /api/v1/credentials/:id/test
{"repoUrl":"https://github.com/acme/demo.git"}
```

规则：

- Secret 使用 AES-256-GCM 加密，AAD 绑定租户、凭据 ID、类型与密钥版本。
- API 只返回 `maskedSecret`；列表与日志不出现明文。
- `PATCH` 携带 `secret` 即轮换密钥；类型不可修改。
- 删除被项目/LLM/环境引用的凭据返回 `409 CREDENTIAL_IN_USE`。
- Git 测试连接使用临时 `GIT_ASKPASS`，不把 token 写入 URL 或 `.git/config`。

## 7. LLM Profile

用途：`generation`（用例生成）、`triage`（归因/修复）、`docs`（文档）、`vision`（视觉）。

```http
POST /api/v1/projects/:projectId/llm-profiles
Content-Type: application/json

{
  "name": "生成模型",
  "purpose": "generation",
  "provider": "deepseek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "credentialId": "cred-llm",
  "params": {"temperature":0.2,"maxTokens":4096,"timeoutMs":60000,"jsonMode":true},
  "enabled": true
}
```

- Provider：`openai-compatible` / `anthropic` / `gemini` / `deepseek`。
- `generation` 是生成任务必需；`triage` 可选，用于归因与修复提案；`docs` 可选；`vision` 供视觉能力配置。
- 连通性测试使用模型列表接口；401/403 归类认证失败。
- `baseUrl` 保存时做 SSRF 静态检查，请求前做 DNS 检查；内网模型需加入 `SSRF_ALLOWLIST`。
- 修改 `provider` / `baseUrl` / `model` / `credentialId` 后健康状态重置为 `unknown`。
- 未配置 triage 时归因只走规则，修复只保留人工建议。

Midscene 视觉：需在 Worker 环境安装 `@midscene/web` 并按 Midscene 文档提供视觉模型环境变量（如 `MIDSCENE_MODEL_*`）；平台不会把项目 `vision` Profile 自动注入 Midscene。缺少依赖/模型时 `[agent]` 步骤返回 `VISION_UNAVAILABLE`，不会静默跳过。

## 8. 测试环境（Environment）

环境只描述**外部 CI/CD 已部署**的测试环境。平台不会安装、构建、启动被测项目。

### 8.1 字段

| 字段 | 说明 |
|---|---|
| `name` | 项目内唯一 |
| `groupId` | 可选，环境分组 |
| `apiBaseUrl` / `webBaseUrl` | API 与 Web 地址，必须 http/https；Web 可选 |
| `healthcheck` | `{url, expectedStatus, timeoutMs}`；失败则 Run 终止 |
| `version` | `source=manual/header/endpoint`；部署版本解析 |
| `testAccountCredentialId` | UI 登录凭据，类型必须 `test_account` |
| `db` | MySQL/PostgreSQL/SQLite 测试库配置 |
| `browser` | viewport、headless、locale、timezone |
| `caseTimeoutMs` | 单用例超时，默认 60s |
| `apiConcurrency` / `uiConcurrency` | 环境执行并发 |
| `isDefault` | 项目默认环境；同项目仅一个 |
| `envVars` | 非敏感变量；敏感名会被拒绝 |
| `setupScript` / `teardownScript` | Suite 内 fixtures/脚本路径；`setupScript` 用于 Run 前造数 |

### 8.2 版本来源

- `manual`：直接使用 `deployedSha`。
- `header`：从健康检查（或 API）响应头读取 `versionHeader`。
- `endpoint`：请求 `versionEndpoint`，用受限 JSONPath `versionJsonPath`（如 `$.sha`、`data.items[0].sha`）解析 SHA。
- `strictVersionMatch=true` 时，部署版本与 Run 目标 `headSha` 不一致会阻断执行；默认只告警并继续。

环境部署版本接口示例：

```http
GET https://staging.example.com/api/version
{"sha":"4f2c1a9..."}
```

### 8.3 数据库配置

```json
{
  "db": {
    "type": "postgresql",
    "host": "db.example.internal",
    "port": 5432,
    "name": "app_test",
    "schema": "public",
    "user": "tester",
    "credentialId": "cred-db",
    "ssl": true,
    "isTest": true,
    "writeMode": "fixtures"
  }
}
```

- `isTest=false` 直接返回 `PRODUCTION_DATABASE_FORBIDDEN`。
- `writeMode=fixtures/full` 需要同时传 `confirmDangerous=true`，否则拒绝。
- `writeMode=readonly` 只能执行 SELECT；`db` 步骤始终只读查询。
- fixtures 只允许参数化 DML，禁止 DDL/多语句；teardown 必须可执行。
- 测试数据使用 Runtime 唯一命名空间（`run_<shortId>_`）。
- 生产数据库保护只是辅助，不应把生产库填入环境。

### 8.4 SSRF 与安全

所有 URL 保存时拒绝私网、回环、link-local、云元数据地址与 `.local/.internal`；内网测试环境必须：

```dotenv
SSRF_ALLOWLIST=staging.example.internal,db.example.internal,*.corp.example
```

环境变量名包含 `password/token/secret/api_key/credential` 等敏感词会拒绝，敏感值请使用凭据引用。

### 8.5 环境分组

```http
GET/POST /api/v1/projects/:id/environment-groups
DELETE   /api/v1/projects/:id/environment-groups/:groupId
```

环境创建/更新时传 `groupId`。分组用于区域/团队/阶段组织与后续环境级运维；`groupId` 必须属于同一项目。

### 8.6 单环境运行

Run 绑定单一 `environmentId`（缺省用项目默认环境）；`environmentId` 必须属于当前项目。平台不部署被测版本，也不做跨环境 A/B 对比——历史基线对比能力已移除，报告只包含本次 Run 自身的结果、趋势与失败归因。

## 9. 飞书通知

```http
POST /api/v1/projects/:projectId/notification-channels
{
  "name":"团队群",
  "webhookUrl":"https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
  "secret":"签名密钥",
  "events":["run_finished","run_failed"],
  "enabled":true
}
```

- Webhook 只允许 HTTPS 的 `feishu.cn` / `larksuite.com` 域。
- Webhook 与 Secret 都加密存储，列表只返回掩码。
- 通知按 Run 汇总，`dedupe_key=runId:channelId:eventType`；同一 Run/渠道/事件只发送一次。
- 最多重试 3 次，响应体脱敏；通知失败不改变 Run 状态。
- 「发送测试卡片」可用于验证配置。

## 10. 触发器

### 10.1 类型与动作

| 类型 | 动作 | 说明 |
|---|---|---|
| `git_webhook` | `generate` / `run` | GitHub/GitLab push 事件；从 payload 取 commit SHA |
| `deployment` | 仅 `run` | 外部 CI/CD 部署完成后回调，可携带 `headSha` |
| `schedule` | `generate` / `run` | 5 段 Cron，UTC；到期由 Worker 调度 |

### 10.2 创建

```http
POST /api/v1/projects/:projectId/triggers
{
  "name":"deploy callback",
  "type":"deployment",
  "action":"run",
  "environmentId":"env-xxx",
  "selection":{"type":"impact"}
}
```

- Webhook/deployment 创建时返回一次性 token，只显示一次；数据库只保存 SHA-256。
- 触发器更新/轮换 token 需要 `PROJECT_UPDATE`；schedule 不需要 token。
- Cron 例：`0 2 * * *` 每天 02:00 UTC。
- 选择类型：`all`、`modules`、`cases`、`impact`（按 base..head 变更路径推断模块）。
- 相同 head + environment + selection 幂等返回已有 Run/Generation。

### 10.3 公开回调

```http
POST /webhooks/git/:projectId
Authorization: Bearer <trigger-token>
Content-Type: application/json

{"after":"<sha>","ref":"refs/heads/main"}
```

```http
POST /webhooks/deploy/:projectId
X-Gait-Token: <trigger-token>
Content-Type: application/json

{"headSha":"<sha>","branch":"main"}
```

`deployment` 回调会更新环境 `deployedSha` 并创建 Run（若选择 impact 且无基线则退化为 all）。公开回调不经过会话/CSRF，只依赖 token；失败记录审计与响应状态。

## 11. CI/PR 集成

```http
POST /api/v1/projects/:projectId/ci-integrations
{
  "name":"github",
  "provider":"github",
  "repository":"acme/demo",
  "tokenCredentialId":"cred-ci",
  "enabled":true
}

POST /api/v1/projects/:projectId/ci-integrations/:ciId/test
POST /api/v1/projects/:projectId/ci-integrations/:ciId/publish
{"runId":"run-xxx","pullRequestNumber":42}
```

- `provider=github` 使用 `/repos/{repo}` 与 issue comments；`gitlab` 使用 `/projects/{encoded}/merge_requests/{iid}/notes`。
- token 必须引用 `git_pat` 凭据；解密只发生在请求内存。
- 发布内容为 Run Markdown 报告摘要，详细链接回到平台；外部 CI 可用部署回调触发 Run，再调用 publish。

## 12. OIDC SSO

### 12.1 Provider

```http
POST /api/v1/tenants/:tenantId/sso-providers
{
  "name":"Corp SSO",
  "issuer":"https://idp.example.com",
  "clientId":"gait",
  "clientSecret":"secret",
  "authorizationEndpoint":"https://idp.example.com/authorize",
  "tokenEndpoint":"https://idp.example.com/token",
  "userinfoEndpoint":"https://idp.example.com/userinfo",
  "scopes":["openid","email","profile"],
  "allowedEmailDomains":["example.com"],
  "defaultRole":"viewer"
}
```

- IdP 回调地址：`${SSO_CALLBACK_BASE_URL}/auth/sso/callback`；未设置时默认 `${PUBLIC_BASE_URL}/api/v1/auth/sso/callback`。
- Client secret 使用 AES-256-GCM；API 只返回配置元数据。
- `allowedEmailDomains` 为空表示不额外限制；非空时必须匹配 email 域。
- 首次 SSO 登录会自动创建用户、绑定 `subject` 并加入当前租户，默认角色为 `defaultRole`；`email_verified=false` 会被拒绝。
- 登录页输入租户 slug 可发现启用 Provider；也可直接访问 `/api/v1/auth/sso/:providerId/start`。
- state 使用 `SESSION_SECRET` HMAC 并绑定 Cookie，回调必须携带同一 state；不实现单点登出。

公开接口：

```http
GET /api/v1/auth/sso/:tenantSlug/providers
GET /api/v1/auth/sso/:providerId/start?redirect=/projects
GET /api/v1/auth/sso/:providerId/callback?code=...&state=...
```

## 13. 配额与用量

```http
GET  /api/v1/tenants/:tenantId/quota
PATCH /api/v1/tenants/:tenantId/quota
{
  "maxRunsPerDay":200,
  "maxConcurrentRuns":5,
  "maxLlmTokensPerMonth":2000000
}
```

- 默认 200 次 Run/日、5 个并发 Run、2,000,000 LLM token/月。
- 创建 Run 前检查；超限返回 429：
  - `QUOTA_CONCURRENT_RUNS_EXCEEDED`
  - `QUOTA_DAILY_RUNS_EXCEEDED`
  - `QUOTA_LLM_TOKENS_EXCEEDED`
- 用量来自当日/当月 Run 与 `stats_json.analysis` 的 LLM token 汇总；不额外维护易漂移计数表。
- 更新配额需要 `tenant:update`（通常 OWNER）。

## 14. Runner 注册与调度

平台管理员：

```http
POST /api/v1/runners
{"name":"runner-a","capacity":2}
```

响应中的 `token` 只显示一次。Worker 设置同名环境变量：

```dotenv
RUNNER_NAME=runner-a
RUNNER_MODE=container
```

外部 Runner 心跳：

```http
POST /runner-heartbeat
Authorization: Bearer <runner-token>
{"name":"runner-a","version":"0.3.0"}
```

- `GET /api/v1/runners` 展示在线/离线（最后心跳 60 秒内为在线）。
- Worker 写 `worker_heartbeats`（readiness）和 `runner_nodes`（注册表）。
- 多 Worker 共享 PostgreSQL 队列，任务领取使用 `FOR UPDATE SKIP LOCKED` 原子完成；**环境互斥锁仍为进程内**，同一环境跨容器并发需要外部串行或后续分布式锁。
- Runner token 只存哈希；删除节点会立即使其注册记录失效。

## 15. Suite 用例与 step 配置

### 15.1 目录

```text
features/
  api/posts.feature
  ui/login.feature
steps/
  registry.json
  plugins/echo.mjs
fixtures/
  seed.yaml
schemas/
templates/
docs/ai/
```

### 15.2 标签与结构

```gherkin
@module:posts @layer:api
Feature: Posts API

  @case:POST-API-001
  Scenario: list posts
    When I send a GET request to "/api/posts"
    Then the response status should be 200
```

- 必填标签：`@module:<key>`、`@layer:ui|api|db|e2e`、`@case:<稳定ID>`。
- 场景必须至少有一个 `Then`；`[agent]` 后必须有 `Then`。
- UI 步骤使用确定性 Playwright 选择器优先，视觉 Agent 只用于复杂流程。
- `@skip` / `@only` / `@wip` 等跳过标签在生成校验中拒绝。

### 15.3 `steps/registry.json`

```json
{
  "steps": [
    {
      "name": "login-as-admin",
      "type": "template",
      "pattern": "I am logged in as {string}",
      "template": "templates/login.md"
    },
    {
      "name": "echo-plugin",
      "type": "plugin",
      "pattern": "I run the echo plugin with {string}"
    }
  ]
}
```

`plugin` 默认从 `steps/plugins/<name>.mjs` 加载；脚本以 JSON stdin 接收步骤、参数、run 信息与变量，向 stdout 输出 JSON。插件受 Suite 路径限制、环境变量白名单、超时与取消约束；平台不执行产品仓库代码。

### 15.4 Fixtures

`setupScript` / `teardownScript` 指向 Suite 内文件；fixtures 仅允许参数化 DML，禁止 DDL/多语句，使用 Run 唯一命名空间，执行后必须 teardown。生产库 / `isTest=false` 永远拒绝写操作。

## 16. 配置校验与审计

保存前校验：必填、长度、URL/域名、路径、枚举、数值范围、凭据类型、项目/环境归属、Suite 模式约束、危险开关。

保存后按需测试：Git `ls-remote`、LLM 模型列表、环境健康检查/版本、飞书测试卡片、CI 仓库访问。

审计动作示例：`project.create/update`、`credential.*`、`environment.*`、`llm_profile.*`、`notification_channel.*`、`run.create/cancel/finish`、`repair.approve/reject/rollback`、`doc.sync/edit/compress`、`trigger.*`、`ci.integration.*`、`sso.*`。审计详情不写密钥、Webhook、token 或 prompt 全文。

## 17. 常见配置错误

| 现象 | 检查 |
|---|---|
| `/readyz` 返回 503 | 数据库是否可写、队列是否可读、Worker 是否在心跳窗口内 |
| Run 立即 `ENV_UNHEALTHY` | `apiBaseUrl`/健康检查 URL、`SSRF_ALLOWLIST`、部署环境是否启动 |
| `ENV_VERSION_MISMATCH` | 版本来源配置、`deployedSha`、目标 `headSha`、`strictVersionMatch` |
| 环境保存 `PRODUCTION_DATABASE_FORBIDDEN` | `db.isTest=true` |
| 环境保存 `DANGEROUS_OPERATION_CONFIRMATION_REQUIRED` | `confirmDangerous=true` |
| 环境保存 `SENSITIVE_ENV_VAR_FORBIDDEN` | 敏感值改用凭据引用 |
| SSO 回调 400 | `SSO_CALLBACK_BASE_URL` 与 IdP 注册地址、state Cookie、state 是否过期 |
| 飞书 403/网络失败 | Webhook 域名、Secret、HTTPS、出网、SSRF 允许列表 |
| S3 403 | `S3_*` 值、bucket 权限、时钟偏差、path style |
| CI 401 | `git_pat` 凭据、仓库名、provider API 地址 |
| 创建 Run 429 | 租户日/并发/LLM token 配额 |
| PostgreSQL 连接失败 / `ECONNREFUSED` | 检查 `DATABASE_URL`、数据库服务、防火墙与连接池上限 |
| `database "gait" does not exist` | 先建库（Compose 已自动创建），再执行 `pnpm db:migrate` |
| 备份/恢复命令找不到 | 部署机安装 `postgresql-client-17`（提供 `pg_dump`/`pg_restore`，大版本需与数据库一致） |
| `AGENT_UNSUPPORTED` / `VISION_UNAVAILABLE` | 配置 Midscene/视觉模型；P0 确定性步骤优先 |

## 18. 配置上线检查清单

- [ ] `.env` 不提交仓库；密钥来自 Secret 管理。
- [ ] `PUBLIC_BASE_URL` 与反向代理外部地址一致。
- [ ] `DATABASE_URL` 与 `CHECKPOINT_DATABASE_URL` 指向不同数据库，且数据库数据目录在持久卷。
- [ ] 生产禁用默认密码；管理员密码 ≥ 12 位且唯一。
- [ ] `SSRF_ALLOWLIST` 仅包含必要内网主机，不加入 `0.0.0.0/0`。
- [ ] 测试数据库 `isTest=true`，写模式二次确认；生产库不配置。
- [ ] Git/LLM/飞书/CI/SSO 凭据测试通过且只显示掩码。
- [ ] Suite `steps/registry.json` 通过 StepRegistry 校验，场景标签齐全。
- [ ] Worker 心跳键在 `/readyz` 通过；Runner 注册名与 `RUNNER_NAME` 一致。
- [ ] S3/CI/SSO 开关在非必要环境保持关闭。
- [ ] `pg_dump`/`pg_restore` 备份恢复已演练。
- [ ] 审计日志可读；跨租户与只读角色访问已抽测。
