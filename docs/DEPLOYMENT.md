# 项目部署手册

> 适用范围：git-ai-test-flow 0.3.0（P0/P1/P2 已完成；M11 平台元数据库已迁移到 PostgreSQL）。
>
> **硬约束**：平台不构建、不部署、不启动、不执行被测产品代码。被测项目由外部 CI/CD 部署，平台只通过 HTTP、浏览器、数据库访问测试环境。
>
> 详细的字段含义、API 示例与 Suite 配置见 [CONFIGURATION.md](./CONFIGURATION.md)；安全与验收边界见 [P0](./P0_ACCEPTANCE.md)、[P1](./P1_ACCEPTANCE.md)、[P2](./P2_ACCEPTANCE.md) 验收报告。

## 1. 部署架构

```text
浏览器
  └─ Web (Nginx/Vite, :8080/:5173)
       └─ API (Fastify, :3000)
            ├─ PostgreSQL gait             平台元数据（业务库）
            ├─ PostgreSQL gait_checkpoints LangGraph checkpoint（独立库）
            ├─ data/artifacts/             截图/Trace/报告（可选 S3 归档）
            ├─ data/workspaces/            Run 临时工作区
            └─ jobs 表
                 └─ Worker (Node)
                      ├─ LangGraph Graph A/B/C
                      ├─ Playwright Chromium
                      ├─ HTTP / DB 执行器
                      └─ 外部已部署测试环境（API/Web/DB）
```

| 服务 | 必需 | 说明 |
|---|---|---|
| Web | 是 | React 静态文件；开发用 Vite，生产用 Nginx |
| API | 是 | 会话、配置、生成/运行 API、报告、SSE |
| Worker | 是 | 队列消费、生成/执行/归因/文档/定时任务；内置 Runner 能力 |
| Runner 容器 | 可选扩展 | 多 Worker 共享任务队列；环境锁需外部串行约束 |
| PostgreSQL | 是 | 平台元数据与 checkpoint；Compose 使用 `postgres:17-alpine`，业务库与 checkpoint 库分离 |
| 外部测试环境 | 是 | 由外部 CI/CD 部署；平台不启动 |

## 2. 前置条件

### 2.1 通用

- Node.js 22.12+、pnpm 10+（非容器部署）。
- 2 vCPU / 4 GB 内存起；Worker 跑 Chromium 建议 8 GB。
- 可写磁盘：至少 20 GB（Git mirror、workspace、artifacts）。
- 对外暴露 Web 的 HTTPS 入口；API 可只监听内网。
- 可访问被测环境（HTTP/HTTPS、数据库端口）；内网环境需在 `SSRF_ALLOWLIST` 显式放行。
- 一个 Git 产品仓库与 Suite 仓库（或使用 managed 模式）。
- 至少一个 LLM Provider（生成必需；归因可选 triage Profile）。

### 2.2 Docker 部署

- Docker Engine 24+、Docker Compose v2。
- 能访问基础镜像：`node:22-bookworm-slim`、`mcr.microsoft.com/playwright:...`、`nginx`。
- 生产建议使用私有镜像仓库和固定 tag。

### 2.3 非容器部署

- Node 22、pnpm 10、PostgreSQL 16+ 服务与 `postgresql-client-17`（`pg_dump`/`pg_restore` 用于备份恢复；客户端大版本必须与服务端一致，平台镜像已内置 17）。
- 若执行 UI：安装 Playwright Chromium：`pnpm exec playwright install --with-deps chromium`（Linux）或 `pnpm exec playwright install chromium`。
- 使用 systemd/PM2/容器编排托管 API 与 Worker 进程。

## 3. 部署前准备

### 3.1 生成密钥

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" # ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))" # SESSION_SECRET
```

二者必须通过 Secret 管理注入；不要写入镜像、Git、日志或工单。`ENCRYPTION_KEY` 更换需要密钥轮换方案，不能直接覆盖已有密文。

### 3.2 准备 `.env`

```bash
cp .env.example .env
```

至少修改：

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://gait.example.com
DATA_DIR=/data
DATABASE_URL=postgresql://gait:<数据库密码>@127.0.0.1:5432/gait
CHECKPOINT_DATABASE_URL=postgresql://gait:<数据库密码>@127.0.0.1:5432/gait_checkpoints
ENCRYPTION_KEY=<32 字节 base64>
SESSION_SECRET=<至少 32 字符随机串>
SSRF_ALLOWLIST=staging.example.internal,*.corp.example
LOG_LEVEL=info
```

连接串里的密码必须做 URL 百分号编码（例如 `@` 写成 `%40`、`#` 写成 `%23`），否则会被 URL 解析器截断。

使用 Docker Compose 时数据库主机为 `postgres`，并额外提供 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_URLENCODED` / `POSTGRES_DB`；`POSTGRES_PASSWORD_URLENCODED` 是同一个密码的 URL 编码形式，Compose 用它拼出上面两个连接串，checkpoint 库固定为 `gait_checkpoints`，由 `docker/postgres/init.sql` 在首次初始化时创建。可用下面的命令生成编码值：

```bash
node -e "console.log(encodeURIComponent(process.argv[1]))" '<数据库密码>'
```

Compose 的 `postgres` 服务只把 5432 绑定在 `127.0.0.1`（可用 `POSTGRES_PORT` 改端口），不会对公网暴露。

完整的变量表见 [CONFIGURATION.md#2-进程环境变量](./CONFIGURATION.md#2-进程环境变量)。

### 3.3 目录与权限

```bash
sudo mkdir -p /data/{backups,artifacts,workspaces,git,suites}
sudo chown -R <运行用户>:<运行用户> /data
```

- 业务库与 checkpoint 库必须是两个不同的 PostgreSQL 数据库（`DATABASE_URL` ≠ `CHECKPOINT_DATABASE_URL`，不允许仅用户名不同）；数据库数据目录需持久化。
- 不要把 `DATA_DIR` 放进会被自动清理的临时目录。
- 生产环境建议 `/data` 独立磁盘并配置容量告警。

### 3.4 外部网络

- 平台 API 需要访问：产品 Git、Suite Git、LLM Provider、（可选）飞书、S3、CI API。
- Worker 需要访问：被测 API/Web/DB、Git、LLM、飞书、S3。
- 测试环境如果在私网，需在 `SSRF_ALLOWLIST` 加入主机；不要用 `0.0.0.0/0` 之类宽泛放行。

## 4. Docker Compose 部署（推荐单机）

### 4.1 启动

```bash
cp .env.example .env
# 设置 POSTGRES_PASSWORD / POSTGRES_PASSWORD_URLENCODED / ENCRYPTION_KEY / SESSION_SECRET / PUBLIC_BASE_URL
docker compose up -d --build
docker compose ps
```

Compose 会先启动 `postgres`（`pg_isready` 健康检查），再启动 `api` 与 `worker`；数据库卷为 `gait-pgdata`，文件数据卷为 `gait-data`。

默认端口：

| 服务 | 端口 | 说明 |
|---|---|---|
| `web` | `8080:80` | Nginx 静态站点 + `/api` 反向代理 |
| `api` | `3000:3000` | Fastify API（可只在内部网络暴露） |
| `worker` | 无端口 | 队列消费、Playwright、定时触发 |

`web` 通过 Compose 内部网络访问 `api:3000`；`worker` 与 `api` 共用 `gait-data` 卷与同一个 PostgreSQL 服务。Nginx 已为 `/runs/:id/events`、`/generations/:id/events` 关闭代理缓冲并放宽 SSE 读取超时。

### 4.2 服务账号

- API 镜像使用非 root `node` 用户；`/data` 在镜像构建阶段设为可写。
- Worker 基于 Playwright 官方镜像，使用 `pwuser`，Chromium 已预装。
- 不要在 Worker 中挂载主机 Docker socket；容器隔离边界见安全章节。

### 4.3 首次管理员

```bash
docker compose exec api sh -lc \
  "cd /app && ADMIN_PASSWORD='至少 12 位密码' node packages/db/dist/cli/admin-create.js --username admin --tenant-slug acme --tenant-name Acme"
```

首次启动 API 会自动执行迁移。若失败，查看 `docker compose logs api`，修复配置后重试。

### 4.4 健康检查

```bash
curl -fsS http://localhost:3000/healthz
curl -fsS http://localhost:3000/readyz
curl -I http://localhost:8080/
```

- `/healthz`：进程存活。
- `/readyz`：数据库可写、队列可读、Worker 心跳未过期；未就绪 503。刚启动时 Worker 尚未第一次心跳，等 10-30 秒再检查。
- `/api/v1/metrics`：平台管理员可读，适合接监控。

### 4.5 登录后的第一件事

1. 用管理员登录 Web。
2. 创建/确认租户与项目。
3. 配置 Git 凭据、LLM Profile、测试环境。
4. 配置 Suite 仓库。
5. 创建生成任务 → 审批 → 创建 Run → 查看报告。
6. 配置飞书、触发器、CI/SSO（可选）。

详细字段和示例见 [CONFIGURATION.md](./CONFIGURATION.md)。

## 5. 非容器部署（Node 进程）

### 5.1 安装与构建

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

### 5.2 迁移与管理员

```bash
pnpm db:migrate
ADMIN_PASSWORD='至少 12 位密码' pnpm admin:create \
  --username admin --tenant-slug acme --tenant-name Acme
```

### 5.3 启动 API / Worker / Web

```bash
# API
NODE_ENV=production pnpm --filter @gait/server start

# Worker（另一个进程；使用同一 .env）
NODE_ENV=production pnpm --filter @gait/worker start

# 开发 Web
pnpm --filter @gait/web dev
# 生产先构建，再用 Nginx 托管 apps/web/dist
pnpm --filter @gait/web build
```

Web 生产必须由 Nginx/静态服务提供，并把 `/api` 反向代理到 API；SSE 路由需关闭缓冲。开发模式下 Vite 默认代理到 `127.0.0.1:3000`。

使用 systemd 时，API 与 Worker 分开 service，`Restart=on-failure`，`EnvironmentFile=/etc/gait/gait.env`；不要在同一进程内混跑 API 与 Worker。

### 5.4 浏览器依赖

Worker 执行 UI 用例需要 Chromium。非容器部署：

```bash
pnpm exec playwright install --with-deps chromium
```

只执行 API/DB 用例时可不安装浏览器；此时 UI 场景会因缺少驱动/配置失败并归因环境问题，不会静默通过。

## 6. 接入外部被测环境

平台不会执行以下事情：`npm install`、`npm run build`、`npm start`、产品测试命令、Docker Compose 启动产品。

外部 CI/CD 的职责：

1. 构建并部署产品到测试环境。
2. 提供健康检查接口。
3. 提供版本接口（返回部署 SHA），或在平台手工维护 `deployedSha`。
4. 部署完成后调用平台部署回调（推荐）或 Git Webhook。
5. 保证环境从平台可达；内网环境加入 `SSRF_ALLOWLIST`。

示例被测应用见 [examples/demo-app/README.md](../examples/demo-app/README.md)；部署后可用：

```bash
DEMO_BASE_URL=https://demo.example.com \
DEMO_DEPLOYED_SHA=<sha> \
pnpm smoke:p0
```

部署回调示例：

```bash
curl -X POST "https://gait.example.com/webhooks/deploy/<projectId>" \
  -H "Authorization: Bearer <trigger-token>" \
  -H "Content-Type: application/json" \
  -d '{"headSha":"<deployed-sha>","branch":"main"}'
```

触发器 token 只在创建/轮换时显示一次；数据库只存 SHA-256。

## 7. 多 Worker / Runner

- Worker 共享 PostgreSQL 队列，任务通过 `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... RETURNING` 原子领取；可启动多个 Worker 容器。
- 多 Worker 的队列与事件写入由 PostgreSQL 行锁/事务保证；连接池与事务应保持短小，高吞吐按项目/租户拆分实例。
- 环境互斥锁是进程内锁；**同一个测试环境不要同时被多个 Worker 执行 Run**，需要部署层串行（例如按环境分队列）或后续分布式锁。
- 平台管理员通过 `POST /api/v1/runners` 注册 Runner，给 Worker 设置 `RUNNER_NAME`，Worker 的心跳写入 `runner_nodes`。
- 生产 Runner 建议非 root、无主机 Docker socket、只读根文件系统（除 `/data` 与临时目录）、CPU/内存限制。
- Playwright 浏览器路径通过镜像或 `PLAYWRIGHT_BROWSERS_PATH` 提供。

## 8. S3 产物归档（可选）

```dotenv
ARTIFACT_STORAGE=s3
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=gait-artifacts
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PATH_STYLE=true
```

- Worker 在 Run 结束后上传本地产物副本；数据库 `storage=s3` 并保存 `metadata.s3Key`。
- 本地文件仍保留；API 下载优先本地，缺失时回源 S3。
- 建议 bucket 开启版本/生命周期策略；平台自己的 `expires_at` 保留策略仍然有效。
- 若只给 Worker 配置 S3 而 API 没有配置，API 无法回源；API/Worker 应使用同一 S3 配置。

## 9. OIDC SSO（可选）

1. 在 IdP 注册回调：`${SSO_CALLBACK_BASE_URL}/auth/sso/callback`；未设置时为 `${PUBLIC_BASE_URL}/api/v1/auth/sso/callback`。
2. 在租户 API/数据库配置 Provider（issuer、client、endpoints、允许邮箱域、默认角色）。
3. 登录页输入租户 slug 发现 Provider，或直接访问 start URL。
4. 首次登录自动创建用户、绑定 subject、加入租户；`email_verified=false` 拒绝。
5. 不支持单点登出；如需禁用 SSO，关闭 Provider 或删除。

注意反向代理必须把回调路径原样转发到 API；`PUBLIC_BASE_URL` 是登录完成后的 Web 地址，`SSO_CALLBACK_BASE_URL` 是 IdP 回调的 API 地址。

## 10. 数据管理

### 10.1 数据卷内容

| 路径/对象 | 内容 | 备份 |
|---|---|---|
| `DATABASE_URL`（`gait` 数据库） | 平台元数据 | 必须 |
| `CHECKPOINT_DATABASE_URL`（`gait_checkpoints`） | LangGraph checkpoint | 建议 |
| `artifacts/` | 截图、Trace、报告 | 可选（S3 归档时） |
| `workspaces/` | 临时工作区 | 否（Run 后清理） |
| `git/mirrors` | 产品/Suite mirror | 可重建 |
| `suites/` | managed Suite | 建议（可重建） |

### 10.2 备份

业务库使用 `pg_dump` 自定义格式（默认写入 `${DATA_DIR}/backups/app-<时间戳>.dump`）：

```bash
pnpm db:backup
pnpm db:backup --out /backups/app-$(date +%F).dump
```

Docker：

```bash
mkdir -p data/backups
docker compose exec api node packages/db/dist/cli/backup.js \
  --out /data/backups/app-$(date +%F).dump
```

checkpoint 库单独备份（建议先停止 Worker，避免执行中的图状态与备份不一致）：

```bash
docker compose stop worker
docker compose exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -Fc -f /tmp/checkpoints-$(date +%F).dump gait_checkpoints'
docker compose cp postgres:/tmp/checkpoints-$(date +%F).dump data/backups/
docker compose start worker
```

生产建议同时开启 PostgreSQL 的持续归档/卷快照；恢复前用 `pg_restore --list` 校验备份可读。

### 10.3 恢复

恢复前停止 API 与 Worker，避免写入；`--confirm` 为强制参数：

```bash
docker compose stop api worker
docker compose run --rm api node packages/db/dist/cli/restore.js \
  --from /data/backups/app-2026-11-23.dump --confirm
docker compose start api worker
```

恢复使用 `pg_restore --clean --if-exists --no-owner --no-privileges`，会覆盖目标库中的同名对象；恢复后确认 `/readyz` 与登录页面。checkpoint 库同理用 `pg_restore -d "$CHECKPOINT_DATABASE_URL" <backup>`。

### 10.4 数据库初始化与升级

```bash
# 创建业务角色与两个独立数据库（Compose 由入口脚本创建 POSTGRES_USER 角色，并用 init.sql 创建 gait_checkpoints）
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE gait LOGIN PASSWORD '<数据库密码>'"
createdb -h 127.0.0.1 -U postgres -O gait gait
createdb -h 127.0.0.1 -U postgres -O gait gait_checkpoints

# 应用前向迁移（API 启动时也会自动执行）
pnpm db:migrate
```

平台只维护 PostgreSQL 一种方言：不再提供 SQLite 导出工具，也不读取 SQLite 存量数据。从 0.3.0 之前版本升级时，重新初始化数据库并创建管理员/租户/项目配置。

### 10.5 数据保留

- 截图 30 天、Trace/video 14 天、运行/报告产物 180 天，数据库保存 `expires_at`。
- 运行/步骤结果建议保留 1 年；文档 T0 原始条目永久保留。
- 定期清理过期产物；清理前校验数据库相对路径仍在 `DATA_DIR/artifacts` 内。

## 11. 升级与回滚

1. 暂停新任务，等待运行中 Run 完成或取消。
2. 备份业务库、checkpoint 库与数据卷快照。
3. 拉取新镜像/代码，执行 `pnpm db:migrate`（前向迁移）。
4. 启动 API，等待 `/readyz` 200；再启动 Worker/Web。
5. 登录并创建/查看一次 Run；执行 `pnpm smoke:p0`（外部 demo 环境）。
6. 失败时回滚镜像，使用备份恢复业务库与 checkpoint 库；不要尝试回滚已应用的前向迁移。

生产升级前至少完成一次恢复演练。

## 12. 可观测性

### 12.1 健康与指标

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库可写、队列可读、Worker 心跳新鲜。
- `GET /api/v1/metrics`：队列、Run、归因、进程内存、在线 Worker；平台管理员鉴权。
- Worker 心跳表：`worker_heartbeats`；Runner 注册表：`runner_nodes`。

### 12.2 日志

pino JSON；包含 `requestId`、`tenantId`、`projectId`、`runId`、`threadId`、`jobId`。访问日志只记录路径，不记录查询串；密钥/token/Cookie/Authorization 已脱敏。建议集中收集 API、Worker 日志，按 `runId` 关联。

### 12.3 告警建议

- `/readyz` 连续失败 > 2 分钟。
- 队列 `queued` 积压或最老任务年龄持续增长。
- Worker 心跳过期；Runner 离线。
- Run 连续失败率上升；归因 `env_issue` 比例异常。
- 磁盘使用率、S3 上传失败、飞书/CI/LLM 连接失败、PostgreSQL 连接数/慢查询/复制延迟。

## 13. 安全基线

- 生产必须 HTTPS；Web 终止 TLS 并反向代理 API。
- API 全局限流默认 600 次/分钟/IP；登录另有账号+IP 双维度限流。
- API 设置 CSP、`X-Frame-Options: DENY`、`nosniff`、Referrer-Policy；生产 HSTS。
- 凭据 AES-256-GCM，AAD 绑定租户/资源/用途；API 只返回掩码。
- 数据库连接默认只读；测试库写模式需二次确认；生产库拒绝。
- SSRF 默认拒绝私网/回环/link-local/云元数据；只放行必要内网主机。
- Suite 脚本/插件在受控子进程中执行，环境变量白名单，不继承平台主密钥。
- 平台不执行被测产品命令；`pnpm check:security` 可扫描产品命令与硬编码密钥。
- Worker 容器不使用 root/主机 Docker socket；按需限制网络出口。

## 14. 故障排查

| 现象 | 排查 |
|---|---|
| `/readyz` 503 | 数据库可写、队列是否可读、Worker 是否在心跳窗口；刚启动等待首次心跳 |
| API 启动失败 | `.env` 校验、`ENCRYPTION_KEY` 长度、`DATABASE_URL` 与 checkpoint 相同、数据库不可达、端口占用 |
| Worker 不消费 | Worker 与 API 是否指向同一 `DATABASE_URL`；任务租约/心跳；`jobs` 表状态 |
| Run 立即失败 | 环境健康检查、`SSRF_ALLOWLIST`、版本来源、`strictVersionMatch` |
| UI 用例失败 | Playwright Chromium 是否安装、`webBaseUrl`、测试账号、选择器、`[agent]` 视觉配置 |
| 登录页 SSO 无 Provider | 租户 slug、Provider enabled、公开 Provider 列表接口 |
| SSO 回调 400 | 回调 URL、state Cookie、`PUBLIC_BASE_URL`/`SSO_CALLBACK_BASE_URL`、时间偏差 |
| S3 403 | 凭证/bucket/region/path style、时钟、IAM 权限 |
| 飞书失败 | Webhook 域名/Secret、出网、签名、SSRF |
| 创建 Run 429 | 租户日/并发/LLM token 配额 |
| PostgreSQL 连接失败/连接数耗尽 | 检查 `DATABASE_URL`、数据库服务与 `max_connections`；缩短事务、复用连接池 |
| 备份/恢复失败（`ENOENT pg_dump`） | 安装 `postgresql-client-17`，确认 `pg_dump`/`pg_restore` 在 PATH 且大版本与数据库一致 |
| Web SSE 不刷新 | Nginx 是否关闭缓冲、API 路由是否被代理；前端保留轮询兜底 |

## 15. 上线检查清单

- [ ] 生产 Secret 已注入，`.env` 未提交。
- [ ] `PUBLIC_BASE_URL` 为浏览器可访问的 HTTPS 地址。
- [ ] `DATA_DIR` 与 PostgreSQL 数据目录在持久卷，业务库与 checkpoint 为不同数据库。
- [ ] `pnpm db:migrate` 成功，`/readyz` 为 200。
- [ ] 首个管理员可登录，普通成员/只读角色隔离已抽测。
- [ ] Git/LLM/环境/飞书/CI/SSO 配置连通性测试通过。
- [ ] `SSRF_ALLOWLIST` 仅包含必要主机。
- [ ] Worker Chromium 可用（如需 UI 测试）。
- [ ] 至少一个外部已部署测试环境完成生成 → 审批 → Run → 报告闭环。
- [ ] 备份、恢复、升级演练完成。
- [ ] 日志/指标/告警已接入。
- [ ] Docker Compose、S3、GitHub/GitLab、OIDC 等外部服务在目标环境完成验收。

## 16. 已知限制

- Docker Compose 未在本开发机实际启动验证（本机无 Docker），需在部署机完成一次完整演练。
- 平台元数据库已迁移为 PostgreSQL（M11）；不再维护 SQLite 运行时，也不迁移存量 SQLite 数据。
- 本机未安装 Docker/PostgreSQL 服务，Compose 与真实 PostgreSQL 的连接、备份恢复需在部署机补做一次演练。
- 环境互斥锁/限流/指标为进程内；多 Worker 同环境并发需部署层串行或后续分布式锁。
- Midscene 真实视觉模型、S3、OIDC IdP、GitHub/GitLab 与外部 CI/CD 需使用真实凭据验证；本仓库测试使用注入实现。
- SSO 未实现 token 撤销/单点登出。
- 平台不提供启动被测应用的脚本；`examples/demo-app` 仅提供源码、Dockerfile 与外部部署示例。
