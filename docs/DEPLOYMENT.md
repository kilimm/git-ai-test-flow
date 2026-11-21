# 部署与运维

> 平台只提供测试编排能力，不部署、不启动被测产品。被测环境由外部 CI/CD 维护，平台通过 HTTP、浏览器和数据库访问。

## 1. 单机 Docker Compose（P0）

前置：Docker Engine 24+、Docker Compose v2、至少 4 GB 可用内存（Worker 运行 Chromium 时建议 8 GB）。

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" # ENCRYPTION_KEY
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))" # SESSION_SECRET
# 编辑 .env，填写以上两个密钥；PUBLIC_BASE_URL 改为浏览器可访问的平台地址
docker compose up -d --build
docker compose ps
curl http://localhost:8080/healthz
curl http://localhost:3000/readyz
```

首次部署后创建平台管理员：

```bash
docker compose exec api sh -lc \
  "cd /app && ADMIN_PASSWORD='至少 12 位密码' node packages/db/dist/cli/admin-create.js --username admin --tenant-slug acme --tenant-name Acme"
```

服务说明：

| 服务 | 端口 | 数据 | 说明 |
|---|---|---|---|
| `web` | 8080 | 静态文件 | Nginx 托管 Web 并反向代理 `/api` |
| `api` | 3000 | `gait-data:/data` | Fastify API、SQLite 迁移 |
| `worker` | - | `gait-data:/data` | 队列消费、Graph A/B、Playwright |

`worker` 使用 Playwright 官方镜像并预装 Chromium，以非 root 用户 `pwuser` 运行。API 使用 Node 非 root 用户。

### 数据卷

- `/data/app.db`：平台元数据。
- `/data/checkpoints/checkpoints.db`：LangGraph checkpoint，必须与 `app.db` 分开。
- `/data/artifacts/`：截图、Trace、报告。
- `/data/workspaces/`：Run 临时工作区，Run 结束后清理。
- `/data/git/`：产品与 Suite mirror。

### 健康检查

- `GET /healthz`：进程存活。
- `GET /readyz`：数据库可写、队列表可查询、最近 Worker 心跳未过期；未就绪返回 HTTP 503。
- `GET /api/v1/metrics`：平台管理员可读的队列、Run、归因与内存指标。

## 2. 备份与恢复

备份使用 SQLite 在线备份 API，不需要停止 API；恢复必须先停止 API 与 Worker。

```bash
# 备份到 ./data/backups（默认）
pnpm db:backup
# 指定目标
pnpm db:backup --out /backups/app-20261121.db

# 检查完整性
node -e "import('./packages/db/dist/index.js').then(m=>console.log(m.checkDatabase(process.argv[1])))" /backups/app-20261121.db

# 恢复（必须显式 --confirm；先停止 API/Worker）
pnpm db:restore --from /backups/app-20261121.db --confirm
```

Docker 部署时把 `DATA_DIR`/`DATABASE_PATH` 指向容器内 `/data`，或把备份文件复制到卷内后执行：

```bash
docker compose stop api worker
docker compose run --rm api sh -lc \
  "cd /app && node packages/db/dist/cli/restore.js --from /data/backups/app-20261121.db --confirm"
docker compose start api worker
```

恢复前脚本会把当前库复制为 `<target>.pre-restore`。升级前必须同时备份 `app.db` 与 `checkpoints.db`。

## 3. 升级与回滚

1. 记录当前镜像 tag 与迁移版本。
2. 停止新任务（取消排队任务或暂停 Worker），等待运行中任务结束。
3. 生成备份：`pnpm db:backup --out /backups/pre-upgrade.db`。
4. 拉取新镜像并执行迁移：`pnpm db:migrate` 或容器内 `node packages/db/dist/cli/migrate.js`。
5. 启动 API → 等待 `/readyz` → 启动 Worker/Web。
6. 执行 `pnpm smoke:p0`（针对外部 demo 环境）与平台登录冒烟。
7. 失败时回滚镜像，并用备份恢复数据库；不要试图回滚已执行的前向迁移。

## 4. 数据保留

- 截图 30 天、Trace/video 14 天、其他运行/报告产物 180 天，由产物写入时记录的 `expires_at` 控制。
- 运行/步骤结果建议保留 1 年；文档 T0 原始条目永久保留。
- 定期清理过期产物文件与索引记录，并在清理前校验数据库中的相对路径仍在 `DATA_DIR/artifacts` 下。

## 5. 安全基线

- 生产必须使用 HTTPS；API 只监听内网或由 Nginx 反向代理。
- `ENCRYPTION_KEY`、`SESSION_SECRET` 通过 Secret 管理，不写入镜像/仓库/日志。
- API 全局限流默认 600 请求/分钟/IP，登录另有账号 + IP 双维度限流。
- CSP、`X-Frame-Options: DENY`、`nosniff`、Referrer-Policy 与生产 HSTS 已由 API 设置。
- 内网测试环境必须加入 `SSRF_ALLOWLIST`；默认拒绝私网、回环、link-local 与云元数据地址。
- 平台不执行被测产品的 install/build/start/test；`pnpm check:security` 会扫描产品命令与硬编码密钥。
- 仅 Suite 仓库中被版本管理的测试脚本会在受控子进程中执行，环境变量使用白名单，不继承平台主密钥。

## 6. P2 扩展运维

### PostgreSQL 迁移导出

平台运行时仍使用 SQLite。需要将元数据迁移到分析库/评估 PostgreSQL 时：

```bash
pnpm db:export:postgres --out ./pg-schema.sql
pnpm db:export:postgres --out ./pg-data.sql --data
psql "$DATABASE_URL" -f pg-schema.sql
psql "$DATABASE_URL" -f pg-data.sql
```

- FTS5 是 SQLite 专属，导出会跳过 FTS 表/影子表，需在 PostgreSQL 重建全文索引。
- 布尔值按 SQLite 的整数语义导出为 bigint/0/1，不做类型迁移。
- 目标测试库的 PostgreSQL 执行能力由 Runner DB 适配器提供，与本迁移工具独立。

### S3 兼容产物存储

```bash
ARTIFACT_STORAGE=s3
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=gait-artifacts
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PATH_STYLE=true
```

Worker 在 Run 完成后上传产物副本，数据库 `storage=s3` 并记录 `metadata.s3Key`；本地文件仍保留。Server 下载时优先本地，缺失再回源 S3。S3 凭证不写入数据库/日志。

### OIDC SSO

1. 在 IdP 注册回调 `${PUBLIC_BASE_URL}/api/v1/auth/sso/callback`（如 API 在独立域名，设置 `SSO_CALLBACK_BASE_URL`）。
2. 通过 `POST /api/v1/tenants/:id/sso-providers` 配置 issuer、clientId、clientSecret、authorization/token/userinfo endpoint、允许邮箱域与默认角色。
3. 登录页输入租户 slug 发现 Provider 并跳转；首次登录自动创建用户、绑定 subject 并加入租户（默认角色）。
4. client secret AES-256-GCM 加密；state 使用 `SESSION_SECRET` HMAC 并绑定 Cookie。SSO 用户首次登录后无法用密码登录，除非管理员另行设置密码。

### 配额

`tenant_quotas` 默认 200 次 Run/日、5 个并发 Run、2,000,000 LLM token/月。管理员通过 `PATCH /api/v1/tenants/:id/quota` 调整；超限创建 Run 返回 HTTP 429。用量来自当日/当月 Runs 与 `stats_json.analysis`。

### 多 Runner 与插件

- 平台管理员通过 `POST /api/v1/runners` 注册 Runner 名称并获取一次性 token；Worker 设置 `RUNNER_NAME` 后写 `runner_nodes` 心跳。多 Worker 通过原子任务领取共享队列。
- 环境锁仍为进程内；多容器同时跑同一环境需要外部串行约束或后续分布式锁。
- Suite `steps/registry.json` 可声明 `"type":"plugin"`，实现文件位于 `steps/plugins/<name>.mjs`，输入 JSON 从 stdin 传入；脚本受路径、环境白名单、超时与取消限制。

## 7. 已知限制（P0-P2）

- Docker Compose 尚未在本开发机实际启动验证（本机未安装 Docker）；配置与健康检查已做静态检查，需在部署机执行一次完整演练。
- 平台元数据库仍为 SQLite；PostgreSQL 是目标库适配与迁移导出，不是平台双后端运行时。
- 环境互斥锁仍为进程内；多 Worker 可共享队列，但同一环境跨容器并发需部署层串行/后续分布式锁。限流与指标也是进程内。
- 真实 S3/OIDC/CI/GitHub/GitLab 服务未在本机连接；使用注入 HTTP 测试验证协议。
- SSO 未实现 token 撤销与单点登出。
- 真实外部 demo 部署由用户 CI/CD 完成；本仓库提供源码、Dockerfile、部署示例与 `pnpm smoke:p0` 检查脚本，不提供服务启动脚本。
