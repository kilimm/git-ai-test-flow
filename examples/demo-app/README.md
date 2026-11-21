# 示例被测应用（demo-app）

该目录是**被测产品**的最小示例，不属于平台 workspace，也不会被平台安装、构建、启动或测试。它必须由外部 CI/CD 部署到一处可访问的测试环境，平台只通过 HTTP 与浏览器访问。

## 能力

| 路径 | 说明 |
|---|---|
| `GET /healthz` | 健康检查 |
| `GET /api/version` | 返回部署 SHA，读取 `DEPLOYED_SHA` |
| `POST /api/login` | 演示账号登录，返回 Bearer token |
| `GET /api/posts?page=&pageSize=` | 分页帖子列表（需要鉴权） |
| `POST /api/posts` | 创建帖子（需要鉴权） |
| `GET /` | 登录页（`data-testid` 稳定选择器） |
| `GET /posts` | 帖子列表页（`data-testid="post-list"`） |

默认账号为 `demo` / `demo-password-123`，可通过 `DEMO_USERNAME`、`DEMO_PASSWORD` 覆盖。数据默认保存在内存 SQLite；设置 `DB_PATH` 可持久化。

## 故意保留的验收缺陷

- `POST /api/posts` 空标题返回 **500**（正确行为应为 400 + `TITLE_REQUIRED`），用于验证 `code_bug` 归因与「禁止自动改测试」。
- `features/ui/posts-ui.feature` 的 `POST-UI-002` 使用已过时选择器 `.posts-container`，实际页面为 `[data-testid="post-list"]`，用于验证 `test_bug` 归因与安全修复建议。
- UI 用例需要为平台环境配置测试账号凭据。

## 本地自测

```bash
cd examples/demo-app
node --test test/*.test.mjs
PORT=8080 DEPLOYED_SHA="$(git rev-parse HEAD)" node server.mjs
```

## 外部部署

1. 把本目录复制到独立的产品仓库，或作为产品仓库的一棵子树。
2. 使用自己的 CI/CD 构建镜像并部署；`deploy/github-actions-deploy.yml.example` 仅为参考，不在平台仓库运行。
3. 部署时注入 `DEPLOYED_SHA`（真实 commit SHA）与 `DEPLOYED_AT`。
4. 在平台创建环境：API Base URL 指向该服务，健康检查 `/healthz`，版本来源选 `endpoint`，端点为 `/api/version`，JSONPath 为 `$.sha`。
5. 确认 `DEPLOYED_SHA` 与平台 Run 的目标 `headSha` 一致；严格模式会阻断不一致的 Run。

平台不会提供启动本应用的脚本。任何「平台执行产品安装/构建/启动/测试命令」的做法都违反项目硬约束。
