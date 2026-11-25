# git-ai-test-flow 开发进度

> 本文是开发进度的**唯一事实源**。每次提交前必须更新，并与代码放入同一个 commit。
>
> 开发步骤、依赖与验收标准见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)；产品设计见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。

## 1. 当前状态

| 项 | 当前值 |
|---|---|
| 更新日期 | 2026-11-25 |
| 当前阶段 | 维护：元数据库 PostgreSQL 迁移（M11，DONE）；生成能力增强（M12，DONE）；脚本库与用例存储双源（M13，DONE）；用例管理与提示词（M14，DONE） |
| 当前步骤 | M13-S1/S2（DONE）/ M14-S1~S3（DONE）/ M14-S4 创建运行模块树与列表分页 / M14-S5 UI 执行健壮性与生成提示词约束（DONE） |
| 总体进度 | **100.0%**（M0-M10 全部完成；M11-S1、M12-S1、M13-S1/S2、M14-S1~S3 维护项已完成） |
| 已完成步骤 | 83 / 83（+ M11-S1、M12-S1、M13-S1、M13-S2、M14-S1~S3 维护项） |
| 最近提交 | `feat(web,server): 创建运行模块树复用用例库数据 + 列表接口分页 [M14-S4]`（本次提交） |
| 本次变更 | 同 M14-S4（见下）。 |
| 本次变更 | ①**创建运行模块树复用已有数据（M14-S4）**：`RunsPage` 打开「创建运行」时优先读取用例库模块树（`GET /projects/:id/case-modules`，按 `@module` 聚合，`CaseModuleNode` 末级 key → 完整层级 key），用例库无模块时才回退到代码扫描结果；`ModulePicker` 传入 `source`，按钮/提示文案与生成页一致，避免选中 key 匹配不到真实用例。②**列表接口分页（M14-S4）**：`GET /projects/:id/runs`、`/generations`、`/cases` 支持 `page`（≥1）/`pageSize`（≤100）参数并返回 `{items,total}`（runs 默认 20/次、generations 默认 20、cases 不传则保持全量兼容）；仓储层新增 `countByProject`/`countActiveCases` 与 `offset` 支持；前端 `RunsPage`/`GenerationPage` 使用服务端分页器，`ProjectOverviewPage`/`CasesPage` 显式取 `items`。typecheck/lint/build 通过；vitest 450 passed（2 个 worker PGlite 失败为既有 `prompt_templates` 缺表问题，与本次无关） |：新表 `script_library`（`(tenant_id,module_key,name)` 唯一，含 pattern/description/params/examples/source/status/version）；`builtin-seeds.ts` 34 条内置 step 按 8 个模块组织并带调用说明与示例；server/worker 启动幂等补种，`RunExecutor.openWorkspace()` 把 active 脚本渲染回 `steps/registry.json`（派生产物，DB 为事实源）；生成侧 `formatScriptCatalog()` 按模块注入 `script_catalog`，提示词要求优先复用、缺口写 `stepProposals`，`proposeScriptDrafts()` 转 draft；API `GET/POST/PATCH /scripts` 与 `POST /scripts/:id/activate`；归因新增 `SCRIPT_FAULT_CODES`，在常规规则前判为 test_bug 避免脚本故障误判成产品缺陷。②**用例存储双源（M13-S2）**：`projects.case_storage`（`repo` 默认 / `db`）+ 表 `case_blobs`；`CaseStore` 抽象 `RepoCaseStore`/`DbCaseStore`，db 模式执行时把整个用例包（features + schemas/templates/fixtures）物化到临时目录作为 `suiteRoot`；`POST /projects/:id/case-migrations` 支持 `repo_to_db`/`db_to_repo`（paths 可选，conflictPolicy 默认 skip，repo→db 用事务全成功或全回滚）；双向安全阀：切 db 要求库内已有 feature，切回 repo 前校验 `pendingExportPaths()` 不一致则 409；项目 PATCH 移除 `caseStorage` 强制走专用接口；生成流程 db 模式 `approve()` 直写 `case_blobs`（`committedSha` 记 `db:<projectId>`）。③**平台缺陷修复**：`{string}` 占位符引号可选且贪婪匹配；`compileStepPattern` 支持字面量 `row(s)`；`test-database-prepared` 新增 `allowDatabaseReset`，仅层并发度=1 时清库；新增 `the raw SQL {anything} should return {int} rows` 与 `I clean up the database rows in {string} where {string} = {string}`；生成重试次数 `<=` 改 `<`。build/lint/vitest 452 passed；message-board repo 与 db 模式各 18/18 通过，往返迁移 diff 为空  |
| 阻塞项 | 无（真实云服务/Docker/跨进程环境锁为已知约束） |
| 下一步 | 进入部署环境验收（真实 PostgreSQL/Docker/E2E）与后续版本演进 |

### 状态图例

| 状态 | 含义 |
|---|---|
| `DONE` | 已完成并通过验收，填写日期与 commit |
| `DOING` | 正在开发，填写开始日期与负责人 |
| `VERIFY` | 代码完成，等待测试/验收，不计入进度 |
| `TODO` | 未开始 |
| `BLOCKED` | 被外部依赖或缺陷阻塞，必须写明原因 |
| `CANCELED` | 取消，必须写明原因与替代方案 |

---

## 2. 里程碑进度

| 里程碑 | 阶段 | 权重 | 步骤数 | 已完成 | 里程碑进度 | 状态 |
|---|---|---:|---:|---:|---:|---|
| M0 文档基线 | P0 | 2% | 3 | 3 | 100% | DONE |
| M1 工程基座 | P0 | 6% | 8 | 8 | 100% | DONE |
| M2 认证与租户 | P0 | 6% | 8 | 8 | 100% | DONE |
| M3 项目与配置 | P0 | 7% | 7 | 7 | 100% | DONE |
| M4 变更分析与用例生成 | P0 | 11% | 10 | 10 | 100% | DONE |
| M5 执行引擎 | P0 | 11% | 10 | 10 | 100% | DONE |
| M6 归因/报告/通知 | P0 | 7% | 9 | 9 | 100% | DONE |
| M7 GUI 基础闭环 | P0 | 5% | 7 | 7 | 100% | DONE |
| M8 P0 验收与加固 | P0 | 5% | 6 | 6 | 100% | DONE |
| M9 P1 增强 | P1 | 27% | 8 | 8 | 100% | DONE |
| M10 P2 扩展 | P2 | 13% | 7 | 7 | 100% | DONE |
| **合计** | - | **100%** | **83** | **83** | **100.0%** | - |

> 计算方式：`Σ(里程碑权重 × 已完成步骤数 / 步骤数)`；仅 `DONE` 计入。详见开发计划 1.5。

---

## 3. 详细进度

### 3.1 M0 文档基线（P0，2%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M0-S1 | 需求与架构基线 | DONE | 2026-11-20 | `5736cb7`、`96868cc` | 24 章、102 代码围栏、7 Mermaid、链接有效 |
| M0-S2 | 示例用例与 README | DONE | 2026-11-20 | `5736cb7`、`96868cc` | 3 个 `.feature`；README 索引有效 |
| M0-S3 | 开发阶段与进度文档 | DONE | 2026-11-20 | `99a1b7e` | 新建计划/进度/CLAUDE.md；步骤 ID 对齐 |

### 3.2 M1 工程基座（P0，6%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M1-S1 | Workspace 初始化 | DONE | 2026-11-20 | `7d5f071` | Node 22/pnpm 10；lint/typecheck/format/verify 通过；code-review 通过 |
| M1-S2 | 应用与共享包骨架 | DONE | 2026-11-20 | `363cb7b` | 3 apps + 7 packages；typecheck/build/check:deps/lint/format 干净构建通过；依赖规则自测可拦截违规；code-review 通过 |
| M1-S3 | 配置/日志/错误/加密基础库 | DONE | 2026-11-20 | `a890d50` | 环境校验、pino 脱敏、RFC 7807、AES-256-GCM、UUIDv7；33 个单测通过；build/typecheck/check:deps/lint/format 通过 |
| M1-S4 | 数据库 schema、迁移与测试库 | DONE | 2026-11-20 | `86b04e6` | Drizzle + better-sqlite3；tenants 根表与初始迁移；WAL/外键/busy_timeout 生效；`db:migrate` 连续执行两次通过；41 个单测通过 |
| M1-S5 | Fastify API 骨架 | DONE | 2026-11-20 | `3d0bd3b` | Fastify 5 + Cookie 插件；`/healthz` 200；`X-Request-Id` 校验与回写；RFC 7807 404/校验/5xx；CSRF double-submit 工具与守卫；访问日志剔除查询串；幂等优雅退出；60 个单测通过；`curl` 健康检查与 404 手工验证；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| M1-S6 | Worker 骨架与任务队列 | DONE | 2026-11-20 | `084e0e1` | `jobs` 表与迁移；单条原子 `UPDATE ... RETURNING` 领取、心跳续租、完成/失败、指数退避、过期租约回收、`dedupe_key` 去重；Worker 单并发轮询、handler 注册、租约丢失中止、优雅退出；checkpoint 独立库初始化与路径校验；`.env` 自当前目录向上查找；86 个单测通过；`db:migrate` 连续两次通过；实际 Worker 进程消费 noop 成功（含重启前排队任务）；app.db 无 checkpoint 表、checkpoints.db 含 `checkpoints`/`writes`；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| M1-S7 | 测试与 CI 基线 | DONE | 2026-11-20 | `c430d45` | Vitest 覆盖率配置与阈值（语句/行/函数 ≥ 80%、分支 ≥ 70%）；Playwright 配置、Chromium 冒烟用例与 `test:e2e`；GitHub Actions 在 PR/main 运行 lint/format/typecheck/test:coverage/build/check:deps/audit:prod 与 E2E；`audit:prod` 脚本；88 个单测通过；覆盖率 92.14% 行、93.04% 函数、77.62% 分支；E2E 本地通过；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| M1-S8 | 进度同步门禁 | DONE | 2026-11-20 | `6c173bc` | `scripts/check-progress.mjs`（staged 与 `--base` 两种模式）；husky 9.1.7 pre-commit 与 `prepare`；CI 在 PR 上以 `origin/<base>` 校验；PR 模板；暂存代码但未改进度文档时实测退出码 1，补登进度文档后通过；`--help`/`--base` 模式验证通过；lint/typecheck/format/test/build/check:deps/audit:prod 通过；code-review 通过（无 medium 及以上问题） |

> **M1 退出验收（2026-11-20）**
>
> - 迁移幂等：`pnpm db:migrate` 连续两次成功；`app.db` 表为 `__drizzle_migrations`、`jobs`、`tenants`，`checkpoints.db` 表为 `checkpoints`、`writes`，应用库与 checkpoint 库分离确认。
> - 队列消费：实际启动 Worker 消费 `noop` 任务，任务为 `succeeded`、`attempts=1`、租约已释放（`locked_by`、`lease_expires_at` 为空）。
> - API：`GET /healthz` 返回 HTTP 200，响应头含 `x-request-id`，body 含 `{"status":"ok",...}`。
> - 质量门禁：19 个测试文件、88 个单测通过；lint/format:check/typecheck/build/check:deps/audit:prod 通过；进度门禁可拦截未同步改动。
> - CI：verify 与 e2e 作业均通过（run `44720997206`，commit `6c34530`）；E2E 复验期间出现过一次瞬时失败，已在 CI 保留安装与 E2E 失败日志注解，复验通过。
> - 结论：M1 退出验收通过，里程碑状态置为 DONE，下一步 M2-S1。

### 3.3 M2 认证与租户（P0，6%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M2-S1 | 租户/用户/会话/成员表与仓储 | DONE | 2026-11-20 | 本次提交 | `users`/`tenant_members`/`sessions`/`audit_logs` 迁移；强制 tenant 过滤、会话撤销、审计游标分页单测通过 |
| M2-S2 | 登录/登出/当前用户/改密 | DONE | 2026-11-20 | 本次提交 | argon2id（19 MiB/t=2/p=1）、token 只存 SHA-256、Cookie HttpOnly+SameSite=Lax+生产 Secure、7 天绝对/24 小时空闲过期、登录轮换；CSRF、错误密码、改密撤销测试通过 |
| M2-S3 | 首个管理员 CLI | DONE | 2026-11-20 | 本次提交 | `pnpm admin:create` 实测创建 admin/acme；重复创建以退出码 1 拒绝；`ADMIN_PASSWORD` 避免密码入 shell 历史 |
| M2-S4 | RBAC 权限矩阵与守卫 | DONE | 2026-11-20 | 本次提交 | 四角色 19 权限点；`requirePermission` 只读会话上下文；矩阵、越权 403 与 `authz.denied` 审计测试通过 |
| M2-S5 | 租户成员管理 | DONE | 2026-11-20 | 本次提交 | 成员列表/添加/改角色/移除；仅 OWNER 管理 OWNER、最后 OWNER 保护、移除撤销会话；生命周期测试通过 |
| M2-S6 | 审计日志 | DONE | 2026-11-20 | 本次提交 | 登录成功/失败、退出、改密、切租户、租户/成员变更与越权写入；`GET /audit-logs` 游标分页与租户过滤测试通过 |
| M2-S7 | 跨租户与安全集成测试 | DONE | 2026-11-20 | 本次提交 | 租户/成员 6 类跨租户接口均 404（先校验租户、再校验权限，任意角色统一 404）；会话固定轮换、CSRF 缺失/不匹配/伪造、登录限流集成测试通过 |
| M2-S8 | 最小登录页与应用外壳 | DONE | 2026-11-20 | 本次提交 | React 登录页、会话守卫、应用外壳、租户切换/退出；Playwright 实测登录→切租户→退出→会话清除 |

> **M2 退出验收（2026-11-20）**
>
> - **管理员 CLI**：`pnpm admin:create` 实测创建 `admin` 与 `acme` 租户；重复执行输出 `A platform administrator already exists` 并以退出码 1 拒绝；创建的管理员可正常登录。
> - **会话与安全**：argon2id 校验、会话 token 哈希存储、7 天绝对/24 小时空闲过期、登录轮换、改密撤销其它会话；CSRF double-submit 对缺失/不匹配/伪造 token 均 403；登录失败限流返回 429。
> - **RBAC 与租户隔离**：OWNER/ADMIN/DEVELOPER/VIEWER 权限矩阵可测试；普通成员无法访问成员管理/审计/租户更新；跨租户租户信息与成员接口 100% 返回 404；`tenant_id` 只从会话派生。
> - **审计**：登录成功/失败、退出、改密、切租户、租户与成员变更、越权尝试可查询；失败登录无租户时 `tenant_id` 为空；游标分页无重复。
> - **GUI**：Playwright 实测 `admin` 登录进入 `/t/acme/projects`，切换 Beta 租户后角色标签更新，退出后刷新回到登录页。
> - **质量门禁**：29 个测试文件、142 个单测通过；覆盖率 92.62% 语句 / 83.77% 分支 / 94.07% 函数 / 92.55% 行；lint/typecheck/build/check:deps/format/E2E 通过。
> - **结论**：M2 退出验收通过，下一步 M3-S1。

### 3.4 M3 项目与配置（P0，7%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M3-S1 | 项目 CRUD | DONE | 2026-11-20 | 本次提交 | `projects` 表与仓储；slug 租户内唯一；managed/external/same_repo 约束；路径/分支校验；`project.create/update/delete/test_connection` 审计；租户隔离与 RBAC 测试通过 |
| M3-S2 | Git 凭据与测试连接 | DONE | 2026-11-20 | 本次提交 | AES-256-GCM + AAD 加密落库；API 仅返回掩码；`PATCH secret` 轮换；引用保护返回 `CREDENTIAL_IN_USE`；临时 `GIT_ASKPASS` 执行 `git ls-remote`，错误码覆盖 DNS/TLS/认证/权限/404/超时/网络；token 不入日志/审计/响应 |
| M3-S3 | LLM Profile 与连通性测试 | DONE | 2026-11-20 | 本次提交 | 四用途、四提供商、凭据类型校验；OpenAI-compatible/DeepSeek/Anthropic/Gemini 认证头与模型端点测试；健康状态落库，连接参数变化回 `unknown`；SSRF 校验 |
| M3-S4 | Environment Profile | DONE | 2026-11-20 | 本次提交 | 健康检查、版本来源 manual/header/endpoint（受限 JSONPath）、`deployedSha` 回写、默认环境唯一；URL SSRF 静态+DNS 校验与 `SSRF_ALLOWLIST`；环境变量敏感名拦截 |
| M3-S5 | 飞书渠道与测试卡片 | DONE | 2026-11-20 | 本次提交 | Webhook/Secret 双密钥加密与掩码；仅 HTTPS 飞书/Lark 域名；签名 `base64(HMAC-SHA256(timestamp+"\n"+secret, ""))`；测试卡片与成功/API 错误/HTTP/网络失败状态 |
| M3-S6 | 配置校验/脱敏/审计 | DONE | 2026-11-20 | 本次提交 | 生产库 `isTest=false` 拒绝；`fixtures/full` 写模式需 `confirmDangerous=true`；仅允许 `db_password`/`test_account` 引用；全链路审计且不含密钥；响应与数据库明文扫描通过 |
| M3-S7 | 配置模块集成测试 | DONE | 2026-11-20 | 本次提交 | 43 个测试文件、205 个单测通过；配置 API 主/异常路径、跨租户 404、加密落库、连接失败错误码、SSRF、限流回归覆盖；覆盖率 90.4% 语句 / 79.69% 分支 / 92.02% 函数 / 90.42% 行 |

> **M3 退出验收（2026-11-20）**
>
> - **项目与配置**：项目 CRUD、Suite 模式约束、Git/LLM/环境/飞书配置均可通过 `/api/v1` 配置；所有列表与详情均绑定会话活动租户，跨租户资源统一 404。
> - **密钥安全**：凭据、Webhook、签名 Secret 使用 AES-256-GCM 加密并绑定租户/资源/用途 AAD；数据库全表扫描未发现明文；API 仅返回掩码，审计详情不含密钥；Git 子进程不继承 `ENCRYPTION_KEY`/`SESSION_SECRET`。
> - **连通性与防护**：Git `ls-remote`、LLM 模型列表、环境健康检查/版本解析、飞书测试卡片均有成功与失败状态；SSRF 默认拒绝回环/私网/link-local/云元数据，私网需 `SSRF_ALLOWLIST`；生产库拒绝与危险写模式二次确认生效。
> - **迁移**：新增 `0003_lowly_anthem.sql`，应用库表为 `__drizzle_migrations, audit_logs, credentials, environments, jobs, llm_profiles, notification_channels, projects, sessions, tenant_members, tenants, users`；`pnpm db:migrate` 连续两次成功。
> - **质量门禁**：43 个测试文件、205 个单测通过；覆盖率 90.4% 语句 / 79.69% 分支 / 92.02% 函数 / 90.42% 行；lint/format:check/typecheck/build/check:deps/audit:prod/E2E 冒烟通过。
> - **结论**：M3 退出验收通过，里程碑状态置为 DONE，下一步 M4-S1。

### 3.5 M4 变更分析与用例生成（P0，11%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M4-S1 | Git mirror/worktree/diff | DONE | 2026-11-20 | 本次提交 | `packages/git` 命令封装、镜像同步、worktree、range/current diff、`--unified=3`、rename/hunk 解析；fixture 仓库黄金测试通过 |
| M4-S2 | 文件过滤与变更分类 | DONE | 2026-11-20 | 本次提交 | 锁文件/构建产物/二进制/测试/生成文件过滤；敏感文件内容清空；单文件 200 KB、总预算 1.5 MB；`FilterStats` 可审计；分类单测通过 |
| M4-S3 | 功能点提取与聚合 | DONE | 2026-11-20 | 本次提交 | 逐文件摘要 + 功能点聚合两阶段 prompt；Zod 结构化输出与一次 JSON 修复；source 路径/hunk 校验、风险/模块/层级归一化；假 LLM 测试通过 |
| M4-S4 | Suite 仓库抽象 | DONE | 2026-11-20 | 本次提交 | managed 本地仓库初始化、external 镜像+推送、same_repo `gait/ai-tests` 分支；路径越界保护；内容未变返回原 commit（幂等） |
| M4-S5 | Gherkin 解析/StepRegistry 干跑 | DONE | 2026-11-20 | 本次提交 | `@cucumber/gherkin` 解析；Tag/`[agent]`/变量式校验；内置 step 目录 + `steps/registry.json` 扩展；3 个示例 feature 全部通过 |
| M4-S6 | 已有用例检索与覆盖判断 | DONE | 2026-11-20 | 本次提交 | `test_cases_fts` FTS5 索引、模块过滤、场景指纹/内容哈希；covered/needs_update/new/obsolete 判断；缺失文件标记 missing 与 obsolete，不物理删除 |
| M4-S7 | Graph A 生成工作流 | DONE | 2026-11-20 | 本次提交 | LangGraph `StateGraph` 节点编排；validate/critique 最多重写 2 次；Worker `generation.run` handler；审批状态持久化；假 LLM 端到端与真实 mirror 测试通过 |
| M4-S8 | 校验器与 critique 重写 | DONE | 2026-11-20 | 本次提交 | 语法/必填 tag/未知 step/`[agent]` Then/secret/重复指纹/空断言/路径校验；step 提案；critique 不合格重写，超限失败；不合格草稿无法提交 |
| M4-S9 | 审批 API 与 Suite 提交 | DONE | 2026-11-20 | 本次提交 | `generations` 创建/列表/详情/编辑/approve/reject；审批重新校验并提交 Suite、更新索引与审计；跨租户 404、非待审状态 409 |
| M4-S10 | 生成链路测试与验收 | DONE | 2026-11-20 | 本次提交 | 3 个提交生成 10 个场景且 100% 通过语法与 StepRegistry 干跑；重复提交幂等；无变更 no-op；54 测试文件、250 单测通过 |

> **M4 退出验收（2026-11-20）**
>
> - **生成链路**：3 个提交的 fixture 仓库经镜像、过滤、逐文件摘要、2 个功能点、10 个场景生成，`validation.valid=true`、`scenarioCount=10`，全部步骤命中 StepRegistry。
> - **审批与提交**：API 创建生成任务入队并发；`awaiting_approval` 可编辑/批准/拒绝；批准后 managed Suite 出现 commit，`generation_files.committed_sha` 与用例索引同步更新；同内容重复提交 `changed=false`；非待审状态返回 409。
> - **幂等与 no-op**：相同 `base/head/selection` 创建请求返回已有 Generation 且只产生 1 个 job；无相关变更/无功能点返回 `no_op`；场景指纹阻止重复用例。
> - **安全**：敏感文件内容不进入 prompt；secret 扫描拒绝可疑密钥；生成/编辑路径限制在 feature 根目录；跨租户生成记录统一 404；审计不记录 prompt 全文或密钥。
> - **迁移**：新增 `0004` 迁移与 `generations`、`generation_files`、`feature_files`、`test_cases` 表及 FTS5 虚拟表；`pnpm db:migrate` 连续两次成功。
> - **质量门禁**：54 个测试文件、250 个单测通过；覆盖率 89.13% 语句 / 77.78% 分支 / 90.4% 函数 / 89.16% 行；lint/format:check/typecheck/build/check:deps/audit:prod/E2E 冒烟通过。
> - **结论**：M4 退出验收通过，里程碑状态置为 DONE，下一步 M5-S1。

### 3.6 M5 执行引擎（P0，11%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M5-S1 | Run 工作区 | DONE | 2026-11-20 | 本次提交 | `data/workspaces/<tenant>/<project>/<runId>` 下产品只读 worktree + Suite + logs/tmp；磁盘配额与清理测试通过（超出配额 `WORKSPACE_QUOTA_EXCEEDED`） |
| M5-S2 | 环境健康与版本校验 | DONE | 2026-11-20 | 本次提交 | healthcheck、manual/header/endpoint 版本解析、完整/短 SHA 比对、strict 阻断、SSRF 静态+DNS 校验；不可达/不一致测试通过；`deployedSha` 回写环境与 Run |
| M5-S3 | DB 适配器与 fixtures/护栏 | DONE | 2026-11-20 | 本次提交 | SQLite 真实驱动；MySQL/PostgreSQL 通过 `mysql2`/`pg` 注入连接工厂测试；只读/DML/DDL/多语句/注释/标识符/参数校验；YAML fixtures、命名空间、teardown、生产库拒绝 |
| M5-S4 | HTTP 执行器与断言 | DONE | 2026-11-20 | 本次提交 | 同源限制、重定向不跟随、CRLF 头拒绝、2 MB 响应上限、超时/取消；状态码/响应头/JSONPath/JSON Schema/错误码/响应时间断言与请求头、响应变量提取测试通过 |
| M5-S5 | DB 步骤与断言 | DONE | 2026-11-20 | 本次提交 | 参数化行数/where 条件/查询行数/结果包含/空表断言；SQL 与结果集快照产物；SQL 注入与只读护栏测试通过 |
| M5-S6 | StepRegistry 与内置步骤 | DONE | 2026-11-20 | 本次提交 | builtin/template/script/api/db/ui 分派；登录模板与确定性 UI 动作；Suite 脚本子进程白名单环境、路径限制、超时/取消杀进程树；agent 步骤 M5 返回 `AGENT_UNSUPPORTED` |
| M5-S7 | Run 编排/并发/取消/超时 | DONE | 2026-11-20 | 本次提交 | API/UI 并发池、环境与 mirror 互斥、单场景超时、Run 级取消轮询 + AbortController；并发/取消/超时测试通过；取消后用例标记 skipped |
| M5-S8 | 产物采集与脱敏 | DONE | 2026-11-20 | 本次提交 | API 请求/响应、DB 快照、截图、Trace、console 落盘与索引；Authorization/Cookie/token/password 递归脱敏；保留期 30/14/180 天 |
| M5-S9 | Graph B 执行主链 | DONE | 2026-11-20 | 本次提交 | prepare→verify→prepare_data→discover→run→aggregate；失败 finalize_failed、取消保持 canceled；`run:<runId>` checkpoint 持久化测试通过 |
| M5-S10 | API/DB/基础 UI 端到端验收 | DONE | 2026-11-20 | 本次提交 | Run API/Worker handler 全链路；API+DB 3 场景通过；50 条 API 场景 Run ≤ 15 分钟（本机测试通过）；环境不可达快速失败；真实 Chromium 截图/Trace 测试通过 |

> **M5 退出验收（2026-11-20）**
>
> - **工作区与版本**：产品镜像只读 worktree、Suite 读取、配额与清理测试通过；Run 开始即记录并展示 `deployedSha`，版本一致/不一致/不可达/严格阻断均有测试；健康检查失败不进入用例执行并归因 `env_issue`。
> - **数据库执行**：SQLite 真实造数/断言/清理通过；MySQL/PostgreSQL 适配器通过注入驱动完成连接、参数化查询与方言占位符测试；生产库非只读配置拒绝；`db` 步骤只允许只读查询，fixtures 只允许参数化 DML 且禁止 DDL。
> - **API / UI**：状态码、JSONPath、JSON Schema、响应头、错误码、响应时间断言通过；请求头设置与响应字段提取通过；Playwright 真实 Chromium 完成输入、点击、截图与 Trace；每个 UI 场景独立 context 且产物入库。
> - **编排**：Run 状态 `queued → preparing → running → succeeded/failed/canceled`；相同请求幂等；API 并发 4 下 50 个场景全部通过且 < 15 分钟；取消可中止进行中的 HTTP 请求并保留已执行步骤；环境互斥与 mirror 锁可重入测试通过。
> - **Graph B 与恢复**：节点顺序、失败短路、取消聚合、checkpoint thread 持久化测试通过；跳过 prepare 节点后可由后续阶段重建工作区（checkpoint 恢复测试）；用例发现幂等，重试不会重复插入 run_cases。
> - **产物安全**：API/DB/console 产物脱敏，截图/Trace 二进制单独存储；数据库仅保存相对路径、SHA-256 与保留期；跨租户 Run API 统一 404，viewer 无创建权限。
> - **迁移**：新增 `0005_magical_bromley.sql`（runs/run_cases/step_results/artifacts/run_events）；`pnpm db:migrate` 连续两次成功，应用库包含全部 M5 表。
> - **质量门禁**：67 个测试文件、301 个单测通过；覆盖率 87.26% 语句 / 76.53% 分支 / 85.90% 函数 / 87.30% 行；lint/format:check/typecheck/build/check:deps/E2E 通过；`audit:prod` 在官方 npm 源无已知高危漏洞（公司镜像缺少 audit 端点）。
> - **结论**：M5 退出验收通过，里程碑状态置为 DONE，下一步 M6-S1。

### 3.7 M6 归因、报告与飞书（P0，7%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M6-S1 | 证据包构建与脱敏 | DONE | 2026-11-21 | 本次提交 | 证据包含步骤/错误/输出、console 尾部、产物、diff hunks、历史结果、feature 源码；递归脱敏 + 1 KB/2 KB 截断；测试覆盖 token/Authorization/password 与日志 JSON 字段 |
| M6-S2 | 规则归因引擎 | DONE | 2026-11-21 | 本次提交 | 规格 13.2 矩阵：重跑→环境/版本→DB/数据→选择器改名→历史通过→断言关联→历史失败→证据不足；14 个矩阵单测 |
| M6-S3 | LLM 归因与结构化输出 | DONE | 2026-11-21 | 本次提交 | Zod schema、引用白名单过滤、低置信降级 unknown、非法 JSON 重试一次、供应商异常规则兜底、冲突记录；假 LLM 10 个单测 |
| M6-S4 | flaky 重跑判定 | DONE | 2026-11-21 | 本次提交 | `RunExecutor.rerunFailedCases` 只重跑 failed/error 且非 env_issue，attempt=2；重跑通过标记 flaky，落 `evidence.rerun`；真实 API 偶发失败测试通过 |
| M6-S5 | 修复建议与 guard | DONE | 2026-11-21 | 本次提交 | `repair_attempts` 表；guard 禁止改 steps/templates/产品代码、删场景/Then、无证据改预期值、agent 替代、超范围；P0 固定人工复核，不自动 apply |
| M6-S6 | 报告生成与导出 | DONE | 2026-11-21 | 本次提交 | 稳定 `RunReport` JSON + Markdown/HTML/JUnit；代码候选、证据引用、复现深链；API 实时重建；Worker 落盘 4 个 report 产物 |
| M6-S7 | 飞书通知与幂等 | DONE | 2026-11-21 | 本次提交 | 签名卡片、按 Run 汇总、`dedupe_key` 幂等、最多 3 次重试、SSRF 复检、响应脱敏；假 Webhook 9 个测试 |
| M6-S8 | Graph B 归因/报告/通知闭环 | DONE | 2026-11-21 | 本次提交 | Graph B 增加 rerun/analyze/report/notify；归因/报告/通知失败非致命；取消跳过；Worker 接入可选 `purpose=triage` LLM |
| M6-S9 | 归因/报告/通知测试 | DONE | 2026-11-21 | 本次提交 | 同一 Run 中 code_bug 与 test_bug 分别识别；失败 Run 端到端 attempt=2 + 报告产物；报告 API 4 种格式与跨租户 404 |

> **M6 退出验收（2026-11-21）**
>
> - **证据包**：失败步骤、期望/实际、console 日志尾部、产物元数据、相关 diff hunks、历史结果与 feature 源码均进入 `evidence_json.evidence`；所有字符串先脱敏后入 LLM/数据库，测试验证 Bearer、JSON token、password、authorization 不落库。
> - **归因**：规则矩阵覆盖规格 13.2 全部信号；重跑通过 → `flaky`；版本不一致 → `env_issue` 且报告标注；历史通过 + 当前失败 + 用例未改 → `code_bug`；选择器改名 + 产品变更 → `test_bug`；证据不足 → `unknown`。同一 Run 的代码 Bug 与用例 Bug 可区分。
> - **LLM 约束**：输出经 Zod 校验；引用必须在受控集合内；无有效引用、低置信度、非法 JSON、供应商异常均回退规则/`unknown`；`code_bug` 强制 `test_repair_allowed=false`。测试使用假 LLM，不依赖外部模型。
> - **防误修**：P0 只记录修复建议，`repair_attempts.guard_status=human_required`；guard 单测覆盖改 steps、删场景、删 Then、无证据改预期值、新增 `@skip`、超 2 次尝试、多文件与低置信等场景。
> - **报告**：JSON/Markdown/HTML/JUnit 字段稳定；HTML 对失败信息做转义；JUnit 仅导出失败用例；`GET /runs/:id/report` 支持四种格式与附件下载，跨租户 404。
> - **通知**：交互卡片包含通过率、失败数、主要问题与深链；签名算法与规格一致；同一 Run + 渠道 + 事件重复调用只发送一次；失败重试 3 次后停止；内网 Webhook 被 SSRF 拦截；响应 token 脱敏。
> - **Graph B**：失败用例先重跑一次再归因；报告与通知在 aggregate 之后执行，失败不覆盖执行结果；取消跳过归因/报告/通知；Worker 崩溃恢复仍使用 `run:<runId>` checkpoint。
> - **数据迁移**：`0006_nifty_edwin_jarvis` 新增 `repair_attempts` 与 `notifications`；`pnpm db:migrate` 连续两次成功；`pnpm db:generate` 无漂移。
> - **质量门禁**：72 个测试文件、358 个单测通过；覆盖率 86.83% 语句 / 76.57% 分支 / 85.41% 函数 / 86.86% 行；lint/format:check/typecheck/build/check:deps/E2E/audit:prod 通过；`audit:prod` 因公司镜像缺少 audit 端点，使用官方源执行无已知漏洞。
> - **结论**：M6 退出验收通过，里程碑状态置为 DONE，下一步 M7-S1。

### 3.8 M7 GUI 基础闭环（P0，5%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M7-S1 | 设计 token 与 Web 基座 | DONE | 2026-11-21 | 本次提交 | GitHub 色值 token、AppShell/项目 UnderlineNav、嵌套路由、API client、`useAsync`/`usePolling`、ErrorBoundary、空态/骨架屏 |
| M7-S2 | 登录/租户切换/权限态 | DONE | 2026-11-21 | 本次提交 | 登录/错误提示/会话守卫、租户切换、按权限显示审计导航与项目设置 Tab；E2E 覆盖错误密码与只读角色 |
| M7-S3 | 项目与设置页面 | DONE | 2026-11-21 | 本次提交 | 项目列表/创建/概览；常规、四类凭据、环境（含 DB/版本/并发）、LLM、飞书、成员设置；删除/写模式二次确认 |
| M7-S4 | 生成与审批页面 | DONE | 2026-11-21 | 本次提交 | 创建(range/current)、3s 轮询、功能点、feature 草稿 DiffViewer、编辑重校验、批准/拒绝；E2E 审批提交本地 bare Suite |
| M7-S5 | 运行列表/详情/证据 | DONE | 2026-11-21 | 本次提交 | 创建/列表/3s 轮询、统计与版本差异、用例过滤、步骤时间线、归因/代码候选/历史/diff/日志、截图/Trace、四种报告导出 |
| M7-S6 | 用例/文档占位/审计页面 | DONE | 2026-11-21 | 本次提交 | 用例索引/FTS 搜索/模块筛选/详情抽屉；文档占位；审计筛选与详情；新增 feature-files/cases API |
| M7-S7 | GUI E2E | DONE | 2026-11-21 | 本次提交 | 独立 E2E API(3100)+Vite(5173) 与种子库；4 个 Playwright 测试通过：登录/环境配置、生成审批、运行证据/用例/审计、跨租户与 viewer |

> **M7 退出验收（2026-11-21）**
>
> - **登录与权限**：正确/错误密码、租户标签、跨租户 URL 重定向；viewer 无新建项目、生成、运行按钮，设置页提示无权限；后端权限与租户校验独立于前端。
> - **配置闭环**：项目列表/创建/概览可用；设置页覆盖常规、Git/LLM/DB/测试账号凭据、环境（含 DB/版本/并发/默认环境）、LLM Profile、飞书渠道与成员管理；凭据仅显示掩码；E2E 新建环境成功。
> - **生成审批**：生成任务列表/详情、功能点、草稿、DiffViewer、编辑与重新校验、批准/拒绝可用；E2E 对种子草稿执行批准，成功校验并提交到本地 bare Suite，界面进入 `已提交`。
> - **运行与证据**：运行详情展示状态、通过率、版本一致性、分类统计、用例过滤与报告导出；用例详情展示步骤时间线、归因/置信度/根因/证据引用、代码文件/行候选、历史/diff/日志、重跑结果与截图入口；产物下载限制在 `DATA_DIR/artifacts`，跨租户 404。
> - **用例/审计/文档**：Feature 文件与场景索引、FTS 搜索、模块筛选与详情抽屉可用；审计页支持动作/资源筛选和详情 JSON；文档页为 P1 占位并明确说明。
> - **E2E 隔离**：Playwright 自动构建并启动独立 API（3100）与 Vite（5173），使用 `data/e2e` 与本地 bare Suite；不依赖外部 LLM/网络/产品环境；4 个测试全部通过（含原冒烟用例）。
> - **质量门禁**：72 个测试文件、359 个单测通过；覆盖率 86.97% 语句 / 76.53% 分支 / 85.81% 函数 / 86.99% 行；lint/format:check/typecheck/build/check:deps/E2E 通过；`pnpm test:e2e` 4 passed。
> - **已知边界**：P0 使用轮询而非 SSE（M9-S4）；用例页只展示可重建索引与元数据，Monaco 在线编辑与文档管理留 P1/M9-S6；antd 6 对部分旧 API（Alert `message`、Statistic `valueStyle`、Drawer `width`、List）给出弃用警告，不影响功能，升级时统一替换。
> - **结论**：M7 退出验收通过，里程碑状态置为 DONE，下一步 M8-S1。

### 3.9 M8 P0 验收与加固（P0，5%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M8-S1 | demo-app 预部署与版本接口 | DONE | 2026-11-21 | 本次提交 | `examples/demo-app` 独立 Node 应用：登录、帖子 API/UI、`/api/version`、空标题 500 缺陷、过时选择器用例；6 个独立 `node:test` 通过；Dockerfile 与外部 GitHub Actions 部署示例；平台不启动产品 |
| M8-S2 | 安全加固 | DONE | 2026-11-21 | 本次提交 | 安全响应头（CSP/XFO/nosniff/HSTS 生产）；API 600 次/分钟/IP 限流与 Retry-After；登录双维度限流保留；prompt 不可信分隔已覆盖；`pnpm check:security` 扫描产品命令与硬编码密钥；跨租户/SSRF/路径/CSRF 测试通过 |
| M8-S3 | 性能与容量 | DONE | 2026-11-21 | 本次提交 | 项目列表 50 次采样 p95 ≤500ms 测试通过；`/readyz` 检查数据库可写/队列/Worker 心跳；`/api/v1/metrics` 输出队列/Run/分类/内存；索引沿用 `idx_runs_*`、`idx_jobs_claim`；产物保留期 |
| M8-S4 | 部署/备份/迁移 | DONE | 2026-11-21 | 本次提交 | API/Worker/Web Dockerfile 与 Compose、Nginx、非 root；SQLite 在线备份/原子恢复 CLI 与 2 个测试；迁移 `0007` 连续执行两次成功；`docs/DEPLOYMENT.md`；本机无 Docker，Compose 启动演练列已知限制 |
| M8-S5 | P0 验收与指标 | DONE | 2026-11-21 | 本次提交 | `docs/P0_ACCEPTANCE.md` 17 项矩阵；`pnpm smoke:p0` 外部 demo 冒烟脚本；内部自动化场景全部通过；真实外部部署/飞书/供应商/容器启动列为部署环境验收项 |
| M8-S6 | 发布 v0.1.0 | DONE | 2026-11-21 | 本次提交 | 版本 0.1.0；`CHANGELOG.md`、`docs/RELEASE_NOTES_v0.1.0.md`、已知问题；本地 tag `v0.1.0` |

> **M8 退出验收（2026-11-21）**
>
> - **质量门禁**：76 个测试文件、368 个单测通过；覆盖率 86.85% 语句 / 76.27% 分支 / 85.99% 函数 / 86.89% 行；lint/format:check/typecheck/build/check:deps/check:security/E2E 4 passed/audit:prod（官方源）通过。
> - **demo-app**：独立 6 个测试通过；版本接口、登录、帖子 API/UI、故意 500 缺陷与过时选择器用例就绪；由外部 CI/CD 部署。
> - **安全**：安全头、API/登录限流、CSRF、SSRF、路径越界、凭据掩码、prompt 不可信分隔与源码扫描全部通过。
> - **运维**：`/readyz`、`/metrics`、Worker 心跳、备份/恢复测试、Docker/Compose 与部署 runbook 完成；Compose 未在本机实际启动（无 Docker）。
> - **验收报告**：`docs/P0_ACCEPTANCE.md`；外部部署、真实飞书/LLM/MySQL/PostgreSQL 与容器启动需在用户环境补验，未伪造通过。
> - **结论**：M8 代码与发布物完成，v0.1.0 本地 tag 就绪；下一步 M9-S1。

### 3.10 M9 P1 增强（P1，27%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M9-S1 | Midscene UI 视觉测试 | DONE | 2026-11-21 | 本次提交 | `VisualAgent`/Midscene 动态加载、`[agent]` When=aiAct/Then=aiAssert、单步截图；缺少依赖返回 `VISION_UNAVAILABLE`；注入假视觉 Agent 测试通过 |
| M9-S2 | 自修复循环与 guard | DONE | 2026-11-21 | 本次提交 | LLM 补丁、guard 预期值变更转人工、`repair_failed` 节点自动应用 allowed 并重跑、Suite 提交；approve/reject/rollback API + UI；审批/回滚集成测试通过 |
| M9-S3 | 历史基线与多环境 A/B | DONE | 2026-11-21 | 本次提交 | Run `baselineEnvironmentId` 校验与视图；报告基线环境近 N 次通过/失败/flaky 摘要；历史查询支持环境过滤 |
| M9-S4 | SSE 事件流 | DONE | 2026-11-21 | 本次提交 | Run/Generation SSE、Last-Event-ID、心跳、终态关闭；前端 EventSource + 轮询兜底；SSE 续传测试通过 |
| M9-S5 | 项目级 RBAC | DONE | 2026-11-21 | 本次提交 | tenant/restricted、项目成员角色、项目资源反查与 404、项目列表过滤；访问设置/成员页面；跨项目 Run 404 测试 |
| M9-S6 | 文档生成/增量/压缩 | DONE | 2026-11-21 | 本次提交 | `packages/docs` manifest/映射/文档/引用/T0-T3；DB 表与 FTS5；Worker `doc.sync`；API/Docs 页面；人工编辑冲突保护；2050 条压缩测试 |
| M9-S7 | Webhook/定时/影响面选测 | DONE | 2026-11-21 | 本次提交 | 触发器 CRUD、一次性 token SHA-256、Git/部署回调幂等、Cron 调度器、`impact` 选测、触发器页面；Webhook/调度集成测试 |
| M9-S8 | Docker runner 与 P1 验收 | DONE | 2026-11-21 | 本次提交 | Worker Playwright 非 root 镜像作为 runner；P1 验收报告；真实容器/视觉/外部 CI 待部署环境补验 |

> **M9 退出验收（2026-11-21）**
>
> - **核心能力**：`[agent]` 视觉步骤、自动/人工自修复、基线 A/B、SSE、项目访问、Graph C 文档、Webhook/定时/影响面选测均已实现；详见 `docs/P1_ACCEPTANCE.md`。
> - **安全**：修复/文档只写 Suite 允许目录；Webhook token 只存哈希；SSE 与项目访问继承会话；FTS 查询参数化；Cron/token 输入校验。
> - **质量门禁**：85 个测试文件、398 个单测通过；覆盖率 81.70% 语句 / 72.36% 分支 / 81.04% 函数 / 81.77% 行；lint/format:check/typecheck/build/check:deps/check:security/E2E 5 passed 通过；迁移 `0008` 连续执行两次并验证 doc/FTS/trigger/project_member 表。
> - **待环境补验**：真实 `@midscene/web` + 视觉模型、Docker 容器、GitHub/GitLab、真实产品仓库与像素级截图对比未在本机验证，未伪造通过。
> - **结论**：M9 代码与验收资料完成，下一步 M10-S1。

### 3.11 M10 P2 扩展（P2，13%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M10-S1 | PostgreSQL 支持 | DONE | 2026-11-21 | 本次提交 | 目标库 PostgreSQL 适配保留；新增 `exportPostgresSql` 与 `pnpm db:export:postgres`（DDL/索引/数据/外键拓扑）；测试通过；平台元数据库仍 SQLite，已记录约束 |
| M10-S2 | 多环境管理 | DONE | 2026-11-21 | 本次提交 | `environment_groups` + 环境 groupId API；Run 基线环境 A/B；租户日/并发 Run 与 LLM token 配额、用量 API、429 阻断；集成测试通过 |
| M10-S3 | CI/PR 集成 | DONE | 2026-11-21 | 本次提交 | `ci_integrations` CRUD、GitHub/GitLab token 连通性、Run 报告评论回写；token 加密/审计；假 HTTP 测试通过 |
| M10-S4 | S3/对象存储产物 | DONE | 2026-11-21 | 本次提交 | SigV4 PUT/GET/DELETE、Worker 归档 `storage=s3` + `s3Key`、Server 回源；S3 client 与 mirror 测试通过；未连真实 S3 |
| M10-S5 | 配额计费与 SSO | DONE | 2026-11-21 | 本次提交 | 配额/用量已覆盖；OIDC Provider CRUD、client secret 加密、state HMAC+Cookie、授权码/userinfo、身份绑定、自动成员、登录页 SSO 发现；注入 OIDC 集成测试通过 |
| M10-S6 | 多 runner 水平扩展 | DONE | 2026-11-21 | 本次提交 | `runner_nodes` 注册/token 心跳 API、Worker `RUNNER_NAME` 心跳、原子任务领取支持多 Worker；跨进程环境锁仍为已知约束 |
| M10-S7 | 插件化 step 与 P2 验收 | DONE | 2026-11-21 | 本次提交 | StepRegistry `plugin` 类型、`steps/plugins/*.mjs` 加载、脚本沙箱；插件执行测试；`docs/P2_ACCEPTANCE.md` |

> **M10 退出验收（2026-11-21）**
>
> - **数据与集成**：PostgreSQL 迁移导出、环境分组/配额、CI/PR 回写、S3 归档、OIDC SSO、Runner 注册、插件 step 均已实现并有测试/验收记录。
> - **质量门禁**：89 个测试文件、410 个单测通过；覆盖率 80.93% 语句 / 70.39% 分支 / 80.00% 函数 / 80.96% 行；lint/format/typecheck/build/check:deps/check:security/E2E 5 passed/audit:prod 通过；迁移 `0009`/`0010` 可重复执行。
> - **已知约束**：平台元数据库仍 SQLite；跨进程环境锁、真实 S3/OIDC/CI/GitHub/GitLab/Docker 未在本机验证；SSO 无单点登出。
> - **结论**：83/83 步骤全部完成，总体进度 100.0%；后续为维护、部署环境验收与版本演进。

### 3.12 M11 元数据库 PostgreSQL 迁移（维护项）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M11-S1 | 平台元数据库由 SQLite 迁移到 PostgreSQL | DONE | 2026-11-23 | 本次提交 | 运行时改 `pg` + Drizzle `node-postgres`，测试用 PGlite；checkpoint 迁移到独立库 `PostgresSaver`；FTS5 改为 `search_text` + `ILIKE`；备份恢复改 `pg_dump`/`pg_restore`；Docker/Compose、CI、`.env.example`、子进程环境隔离同步；90 测试文件/424 单测通过；验收见下方 |

> **M11-S1 迁移范围（2026-11-23）**
>
> - **驱动与连接**：`packages/db` 删除 `better-sqlite3` 运行时，`openDatabase` 只接受 `postgres://`/`postgresql://`；仓储方法全部异步化。
> - **SQL 方言**：布尔改原生 boolean、毫秒时间戳/大小改 `bigint`、二进制改 `bytea`；任务领取用 `FOR UPDATE SKIP LOCKED`，Run 事件 seq 用行锁串行化。
> - **检索**：移除 FTS5/`MATCH`/`bm25`，新增 `doc_modules.search_text` 缓存列，多 token `ILIKE` 检索。
> - **Checkpoint**：Worker 使用 `@langchain/langgraph-checkpoint-postgres`，`DATABASE_URL` 与 `CHECKPOINT_DATABASE_URL` 强制指向不同数据库（服务层校验）。
> - **运维**：`db:backup`/`db:restore` 改用 `pg_dump --format=custom` / `pg_restore --clean --if-exists`；`db:export:postgres` 与 SQLite 导出工具删除。
> - **不迁移存量数据**：迁移后重新初始化数据库并执行 `pnpm db:migrate`。

> **M12-S1 生成能力增强（2026-11-23）**
>
> - **颗粒度**：`generations.stats.granularity`（`high/medium/low`），注入 summarize/extract/design/critique prompt；与模块选择正交。
> - **全量基线**：`mode=baseline`，以空树 `4b825d…` 为 base 拉全仓快照；diff 预算裁剪通过 `stats.incomplete` / `filesTruncated` 透出，不静默丢文件。
> - **模块识别**：`packages/shared/src/module-tree.ts` 统一定义规范化/前缀匹配/模块树；`inferModulesFromPath` 层级化；LLM 模块名收敛为 slug。
> - **按模块生成**：`selection.modules` 前缀匹配（选 `posts` 命中 `posts.comments`），baseline/current/range 全部生效。
> - **模块清单**：`GET /projects/:id/modules` + `POST /projects/:id/modules/scan`（`module.scan` job，路径推断、10 分钟缓存）。
> - **前端**：生成表单与「一键生成初始用例集」表单新增模块树多选 + 手填 key；详情展示模式/颗粒度/识别模块/裁剪告警。
> - **质量门禁**：新增 `packages/shared/test/module-tree.test.ts`、workflow 颗粒度/模块用例、server baseline/模块接口用例、worker baseline/模块扫描用例；`typecheck`（含 web）、目标测试全部通过。

> **M11-S1 退出验收（2026-11-23）**
>
> - **迁移范围**：驱动与仓储异步化、PG 方言（boolean/bigint/bytea/`SKIP LOCKED`/行锁）、`search_text` + `ILIKE`、checkpoint 独立库、备份恢复与部署链路全部切换到 PostgreSQL；平台运行时不再依赖 `better-sqlite3`（`packages/runner` 仅保留其作为被测项目 SQLite 适配器）。
> - **审查修复**：最后一 owner 竞态、`/notifications` 项目越权、`/readyz` 与 SSE 错误泄漏、Git 子进程密钥环境、CI 集成 projectId 校验、Run 取消轮询与产物写入容错、`RUN_ABORTED` 透传重试、generation 清理、触发器事务化入队、通知发送成功后的落库顺序、E2E 清库库名边界、Docker PG17 客户端与 Compose 密码 URL 编码。
> - **质量门禁**：90 个测试文件、424 个单测通过（3 skipped）；覆盖率 81.25% 语句 / 70.53% 分支 / 80.15% 函数 / 81.30% 行；lint/format/typecheck/build/verify:workspace/check:deps/check:security/audit:prod 通过；浮动 Promise 扫描 0 处。
> - **已知约束**：本机无 Docker/PostgreSQL 客户端，真实 PG 的 E2E 与 `pg_dump`/`pg_restore` 演练需在部署机补验；CI 已配置 `postgres:17-alpine`。
> - **结论**：M11-S1 完成；SQLite 存量数据不迁移，升级后重新初始化数据库。

### 3.13 M13 脚本库与用例存储双源（维护项）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M13-S1 | 租户级脚本库（step 唯一定义来源 + 生成侧复用目录 + 提案转 draft + 脚本层归因） | DONE | 2026-11-24 | 本次提交 | 34 条种子/8 模块；启动还原与幂等补种；API 搜索/创建/冲突/激活实测通过 |
| M13-S2 | 用例存储双源（repo/db）+ 双向迁移（事务、冲突 skip、双向安全阀） | DONE | 2026-11-24 | 本次提交 | repo 模式 18/18、db 模式 18/18；往返迁移 `cd117d2..92f1284` diff 为空 |

> **M13 关键设计（2026-11-24）**
>
> - **脚本库是 step 的唯一事实源**：`steps/registry.json` 降级为派生产物，每次 `RunExecutor.openWorkspace()` 从 DB 重建；租户级共享避免每项目重复维护 UI/DB 通用 step。
> - **DB 模式必须整包物化**：只迁 `features/` 会让 `JSON Schema "schemas/x.json"` 这类相对引用读不到，因此资源目录（`schemas/templates/fixtures`）与用例一并入库，执行时物化到 `/tmp/gait-cases-*` 作为 `suiteRoot`。
> - **迁移不做隐式双写**：显式 API 动作 + 审计，避免两边内容漂移后无法判定真相；冲突默认 `skip` 并回报明细。
> - **为什么仍保留 repo 模式**：Git 提供版本历史/可 review/可回滚，现有项目无需迁移。
> - **已知简化**：`steps/` 不参与用例迁移（脚本库是 tenant 级唯一事实源，迁入会与启动还原冲突）。

### 3.14 M14 用例管理与提示词（维护项）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M14-S1 | 提示词模板（tenant 级 4 阶段覆盖）+ 生成任务额外需求注入 | DONE | 2026-11-25 | 本次提交 | 保存/恢复默认、带 `extraInstructions` 生成实测通过 |
| M14-S2 | 用例在线编辑 + step 补全 + 模块树/模块 rename/delete/新增 | DONE | 2026-11-25 | 本次提交 | message-board 实测：保存 feature、建模块树、move-module、rename、delete(unknown)、delete(cases) 全部成功 |
| M14-S3 | 视觉 agent 图片上传注入 + 夹具变量展平 | DONE | 2026-11-25 | 本次提交 | 远端浏览器场景下隐藏 `<input type=file>` 注入成功 |

> **M14 关键设计（2026-11-25）**
>
> - **提示词按租户而非按项目**：同一租户下所有项目的生成策略一致，避免逐项目重复维护；`content` 为空即恢复内置默认，无需额外「重置」状态。
> - **额外需求放在 `generations.stats`**：与任务同生命周期，历史任务天然为空串；不新增表，回写 `awaiting_approval`/`failed` 状态时保留。
> - **文件上传不能依赖 `setInputFiles`**：UI 用例的浏览器可能不在 worker 同机，路径不可读，因此改为页面内构造 `File`+`DataTransfer` 并触发 `change`，让页面自身压缩逻辑照常执行。
> - **已知遗留**：删除用例无 Git 历史回滚入口；新增模块仅前端生成骨架，落库依赖保存；step 补全按前缀过滤、无语义排序。

## 4. 最近提交

| 日期 | Commit | 类型 | 摘要 | 关联 Step |
|---|---|---|---|---|
| 2026-11-25 | 本轮修复双提提交（接 M14-S4）：④**视觉/选择器健壮性**：`PlaywrightUiDriver` 的 `firstUsable`/`isVisible` 新增 `selectorCandidates`（先按 CSS 试，失败再试 `text=` / `role=button|link[name=]`，无中文的 CSS 选择器不扩展），修复用例直接写可见文案（如「发布」）时 `locator()` 抛 CSS 解析错误而使 `ui-visible`/`click`/`fill` 直接失败的问题（`ui-visible` 本就声明支持「文本或选择器」）；⑤**视觉上传短路**：`uploadImageFile` 移到 Midscene agent 构造**之前**，注入成功且指令以「选/传图片」为主（新增 `isUploadPrimaryInstruction`，排除「并填写…」等后续动作）时直接返回成功，避免模型看不到隐藏 `<input type=file>` 又把已成功的上传判失败；`IMAGE_UPLOAD_INTENT` 放宽到分句内（不再要求紧邽动词），尺寸正则 `(\d{2,5})\s*(?:x|×|\*)\s*(\d{2,5})` 修复含空白时漏匹配；⑥**生成提示词规则 12/13**：禁止假设代码里没有的阈值校验（区分前端压缩上限 vs 后端拒绝阈值）、禁止假设不存在的图片夹具键，并修正续行缩进对齐 | M14-S4~S5 | typecheck/lint 通过；`vitest packages/runner packages/agent` 24 files / 156 tests 全通过；web build 通过 |
| 2026-11-25 | 本次提交 | feat(web,server) | 创建运行模块树复用用例库数据 + runs/generations/cases 列表接口分页（M14 分块） | M14-S4 |
| 2026-11-25 | 本次提交 | feat(server) | 提示词模板服务/API + 额外需求落库 + worker 覆盖接线修复（M14 分块提交，第 2/4） | M14-S1 |
| 2026-11-25 | 本次提交 | fix(runner,git) | 用例文件读写/模块编辑与删除提交 + 视觉 agent 图片注入 + `moduleOf` 层级模块修复（M14 分块第 4/4） | M14-S2 ~ M14-S3 |
| 2026-11-25 | `0fd2deb` | feat(web) | 用例在线编辑/模块树管理页 + StepEditor 补全 + 提示词设置页与额外需求表单（M14 分块第 3/4） | M14-S2 |
| 2026-11-25 | `0cca4ea` | feat(server) | 提示词模板服务/API + 额外需求落库 + worker 覆盖接线修复（M14 分块第 2/4） | M14-S1 |
| 2026-11-25 | `0d0821b` | feat(db,agent) | 提示词模板表与迁移 0005 + 生成阶段覆盖/额外需求注入 + 夹具变量展平（M14 分块第 1/4） | M14-S1 |
| 2026-11-24 | 此前提交 | feat(m13) | 租户级脚本库 + 用例存储双源（repo/db）与双向迁移 + 6 项平台缺陷修复 | M13-S1 ~ M13-S2 |
| 2026-11-24 | 此前提交 | feat(run) | API-agent 执行器（api/db 层 [agent]→HTTP）+ 加密协议显式步骤 + 自动造数 + 生成规则 + worktree/幂等修复 | M12-S2 |
| 2026-11-23 | 此前提交 | fix(generation) | 修复生成链路与校验器缺陷，baseline 全量生成端到端跑通（含 `vite base` 子路径修复） | 缺陷修复 |
| 2026-11-23 | `74b8ca0` | feat(m12) | 生成颗粒度、全量基线生成与层级模块识别、按模块生成 | M12-S1 |
| 2026-11-23 | 此前提交 | feat(db) | 平台元数据库由 SQLite 迁移到 PostgreSQL | M11-S1 |
| 2026-11-21 | 本次提交 | docs(deploy) | 新增项目部署手册与项目配置手册 | 文档 |
| 2026-11-21 | `01f90ac` | feat(m10) | PostgreSQL 迁移导出/环境组/配额/CI/S3/SSO/多 Runner/插件与 P2 验收 | M10-S1 ~ M10-S7 |
| 2026-11-21 | `508e1e3` | feat(m9) | 视觉/自修复/基线/SSE/项目 RBAC/文档 Graph C/触发器与 P1 验收 | M9-S1 ~ M9-S8 |
| 2026-11-21 | `a216846` | feat(m8) | demo-app、安全/运维加固、P0 验收与 v0.1.0 | M8-S1 ~ M8-S6 |
| 2026-11-21 | `6690026` | feat(m7) | 完成 GUI 基座、配置/生成审批/运行证据/用例审计页面与 E2E | M7-S1 ~ M7-S7 |
| 2026-11-21 | `2d57a4a` | feat(m6) | 完成证据包、规则/LLM 归因、重跑、修复 guard、报告与飞书通知 | M6-S1 ~ M6-S9 |
| 2026-11-20 | `56d2ce0` | feat(m5) | 完成 Run 工作区、执行引擎、Graph B 与 Run API | M5-S1 ~ M5-S10 |
| 2026-11-20 | `988f8da` | feat(m4) | 完成变更分析、用例生成、审批与 Suite 提交 | M4-S1 ~ M4-S10 |
| 2026-11-20 | `2255a2c` | feat(m3) | 完成项目、凭据、LLM/环境/飞书配置与安全防护 | M3-S1 ~ M3-S7 |
| 2026-11-20 | `5d9dc32` | feat(m2) | 完成认证、租户、RBAC、审计与登录页 | M2-S1 ~ M2-S8 |
| 2026-11-20 | `0d23f83` | docs(m1) | M1 工程基座退出验收 | M1 |
| 2026-11-20 | `6c34530` | ci(m1) | 输出 E2E 失败详情 | M1-S7 |
| 2026-11-20 | `58be272` | ci(m1) | 增加 Chromium 安装失败诊断 | M1-S7 |
| 2026-11-20 | `e3b42d3` | fix(ci) | 修复 Playwright 浏览器安装回退 | M1-S7 |
| 2026-11-20 | `6c173bc` | chore(m1) | 新增开发进度同步门禁 | M1-S8 |
| 2026-11-20 | `c430d45` | ci(m1) | 新增测试、构建与依赖边界检查 | M1-S7 |
| 2026-11-20 | `084e0e1` | feat(m1) | 新增 Worker 任务消费骨架 | M1-S6 |
| 2026-11-20 | `3d0bd3b` | feat(m1) | 新增 Fastify API 骨架与健康检查 | M1-S5 |
| 2026-11-20 | `86b04e6` | feat(m1) | 新增数据库 schema、迁移与测试库工具 | M1-S4 |
| 2026-11-20 | `a890d50` | feat(m1) | 新增配置、日志、错误与加密基础库 | M1-S3 |
| 2026-11-20 | `363cb7b` | chore(m1) | 建立应用与共享包骨架 | M1-S2 |
| 2026-11-20 | `7d5f071` | chore(m1) | 初始化 pnpm workspace 与工程规范 | M1-S1 |
| 2026-11-20 | `99a1b7e` | docs(plan) | 新增开发阶段与进度文档 | M0-S3 |
| 2026-11-20 | `96868cc` | docs(spec) | 改为对已部署测试环境执行并解除语言框架限制 | M0-S1、M0-S2 |
| 2026-11-20 | `5736cb7` | docs(spec) | 新增 AI 测试平台开发设计文档 | M0-S1、M0-S2 |
| 2026-11-20 | `e26072e` | chore | Initial commit | - |

---

## 5. 变更日志

| 日期 | 变更 | 影响 Step | 备注 |
|---|---|---|---|
| 2026-11-25 | 创建运行对话框模块目录树改用用例库已有数据（`case-modules` 模块树，含数量），无模块时才回退代码扫描；`RunsPage` 同生成页复用 `ModulePicker` 的 `source` 提示。列表接口分页：`GET /projects/:id/runs`、`/generations`、`/cases` 新增 `page`/`pageSize` 并返回 `{items,total}`（runs/generations 默认 20/页，cases 不传参数保持全量）；仓储层加 `countByProject`/`countActiveCases` 与 offset；前端运行/生成列表改用服务端分页器 | M14-S4 | 兼容旧行为：不传分页参数时接口仍返回全量或默认上限；typecheck/lint/build 通过 |
| 2026-11-25 | UI 执行健壮性 + 生成提示词约束：`selectorCandidates` 支持按可见文本/角色定位（修复中文文案当选择器时 CSS 解析报错）；视觉上传在 Midscene 构造前注入并在「主上传」指令下短路（避免已上传被判失败）；上传意图/尺寸正则放宽；DESIGN 规则 12/13 禁止臆断阈值与夹具键 | M14-S5 | runner/agent 156 tests 通过；typecheck/lint/build 通过 |
| 2026-11-25 | ①**提示词统一管理**：新表 `prompt_templates`（tenant 级每阶段一行，`content` 为空 = 内置默认）+ 迁移 `0005`；`GET/PUT /prompt-templates/:stage` 与项目设置→提示词页（`tenants:update`）；生成任务新增「额外需求」`extraInstructions`（持久化在 `generations.stats.extraInstructions`，以 `<user_requirement>` 注入 summarize/extract/design/critique 四阶段，冲突时以用户需求为准）；修复 worker `generation-handler` 从未读取提示词覆盖的接线缺陷；新增 `flattenFixtureVariables` 把夹具展平成点路径供提示词引用。②**用例在线编辑与模块管理**：`GET/PUT /projects/:id/case-files`（repo 走 `writeAndCommit`、db 走 `case_blobs`，保存后重建索引）、`POST /projects/:id/case-files/move-module`、`GET /projects/:id/case-modules` 模块树（按 `@module` 点分层级聚合）、`POST /projects/:id/case-modules/edit`（rename 前缀重写 / delete 整文件或删场景块 / 新增模块）；`StepEditor` 依据脚本库 34 条 step pattern 做行内前缀补全；`suite-repository.deleteAndCommit` 限定用例目录；修复 `moduleOf` 正则不允许点号导致层级模块被索引为 `unknown`；用例索引标注 `missing`（索引有、仓库已删）。③**视觉上传与夹具**：视觉 agent 在「上传/选择文件」类指令前用页面内 `File`/`DataTransfer` 注入 base64 图片（适配浏览器与 worker 跨机场景），并按 `MIDSCENE_FILE_CHOOSER_DIR` 设置 `fileChooserAccept` | M14-S1 ~ M14-S3 | `tsc -b`（server/worker/agent/runner/git）与 web typecheck 通过；depcruise 无违规、check:security/check:progress 通过；新增审计动作 `prompt_template.update`/`case.edit`/`case.move_module`/`module.rename`/`module.delete` |
| 2026-11-24 | ①**租户级脚本库**：新表 `script_library` 成为 step 的唯一定义来源，`steps/registry.json` 降级为派生产物（每次 workspace 准备时从 DB 重建）；34 条内置 step 按 8 个模块组织并带调用说明与示例，供生成阶段检索复用，减少 LLM 自由发挥；`stepProposals` 落 draft，激活需真实用例验证；归因新增脚本故障码，避免脚本故障被误判为产品缺陷。②**用例存储双源**：`projects.case_storage` 支持 `repo`（Git 为事实源，默认）与 `db`（数据库为事实源）；db 模式执行时整包物化（features + schemas/templates/fixtures）到临时目录作为 `suiteRoot`；双向迁移 API 带事务与冲突策略，两侧不一致时拒绝切换；生成流程 db 模式直写 `case_blobs`。③**平台缺陷**：`{string}` 占位符引号可选、`row(s)` 单复数合并、`test-database-prepared` 并发清库保护、新增裸 SQL 断言与按条件清理 step、生成重试次数修正 | M13-S1 ~ M13-S2 | build/lint 全绿；vitest 452 passed / 0 failed；message-board repo 与 db 模式各 18/18 通过，往返迁移 diff 为空 |
| 2026-11-24 | ①新增 API-agent 执行器：api/db 层 `[agent]` 步骤由 LLM 转为真实 HTTP 请求执行（不再误走视觉 UI，修复「api 场景 [agent] 在空白页失败」）；②新增加密协议步骤 `send encrypted JSON` / `decrypt response`（AES-256-CBC，与 message-board 一致），API 用例可正确处理传输加密；③`test-database-prepared` 清基线 + `db-row-count` 数据不足自动造数（修复「should have 1000 rows 但只有 1 行」）；④生成 prompt 新增「步骤明确优先显式、`[agent]` 仅兜底」；⑤suite worktree 移出仓库外 + `assertRefExists` 提前校验；⑥`uq_runs_idempotency` 改部分唯一索引（仅 queued/running），修复失败后无法重建；⑦同步 PROJECT_SPEC §11.4/11.5/11.6/§12 与新步骤、agent 分层路由 | M12-S2 | typecheck/build/check:deps 通过；实测 api 层 8/8 passed；ui 导航路径 留言板→/ 已修正 |
| 2026-11-23 | 创建运行页体验优化：①新增 `GET /projects/:id/commits` 读取产品镜像最近提交（时间倒序，`sha/shortSha/title/author/committedAt`），`packages/git` 新增 `listRecentCommits`；②Head/Base SHA 由手输改为 commit 下拉（显示 `shortSha · 标题`，支持搜索），并增加「最新」快捷按钮一键填入最新 commit；③用例选择去掉「按 caseKey」，改为复用 `ModulePicker` 模块目录树（选父模块命中整棵子树，可再手补模块 key）；④新增 `assertWorktreeReady`/`assertRepositoryRoot` 守卫并把 suite worktree 移到系统临时目录，修复「提交用例集时误提交到外层项目仓库并触发 husky 拦截」的问题 | 体验优化 | typecheck/lint/build 通过；提交历史接口在镜像缺失时返回空列表并告警而非 500，不阻断创建流程 |
| 2026-11-23 | 修复生成链路与校验器缺陷，使 baseline 全量生成可端到端产出待审批用例集：①`MODULE_TAG` 正则由 `[A-Za-z0-9_-]+` 放宽为 `[A-Za-z0-9._-]+`，修复层级模块 key（`server.api`）被校验器拒绝的根因；②`normalizeDrafts` 改用 `normalizeModuleKey` 保留模块层级，并新增 `ensureModuleTag` 兜底补全遗漏的 feature 级 `@module` 标签；③幂等查询仅对未终结状态去重，并为重试派生 `#retry=N` 后缀键，避免被历史失败记录拦截或触发唯一约束；④`stepProposals` schema 兼容 `phrase`/`stepText` 等字段漂移并改为 strip，prompt 明确写出字段结构；⑤`extract` 输出上限由 4096 提至 32768 并在 prompt 约束描述长度；⑥LLM 默认超时 60s→300s、默认 `maxTokens` 4096→32768，各生成节点提至 32K/64K/16K，并新增空 `content` 检测（`LLM_EMPTY_CONTENT`，报出 `finish_reason`）；⑦`[agent]` step 位置规则明确；critique 评审标准收敛为仅拦硬性缺陷，`MAX_RETRIES` 2→3；⑧`vite.config.ts` 补 `base` 配置修复 `/gait/` 子路径部署白屏 | 缺陷修复 | 实测 baseline 生成由 `failed` 转为 `awaiting_approval`：9 功能点 / 31 场景 / 8 个 feature 文件全部 `valid`，重试 1 次、耗时 135s、token 27K/32K；`tsc -b` 与 `pnpm build` 通过；`gait-api`/`gait-worker` 重启后正常 |
| 2026-11-23 | 新增生成颗粒度（high/medium/low）、`baseline` 全量生成模式（空树快照）、层级模块识别（`posts.comments`）、`selection.modules` 前缀匹配、模块清单扫描接口 `GET/POST /projects/:id/modules` 与前端模块树多选；统计新增 `mode/granularity/incomplete/filesTruncated/modules`；模块扫描结果写入 `projects.settings_json.moduleScan` 支持 API/Worker 分进程部署；Web 增加 `BrowserRouter basename` 支持子路径部署 | M12-S1 | 新建 `packages/shared/src/module-tree.ts`；`inferModulesFromPath` 层级化并补全祖先；模块树写入 `generation.stats.modules`；类型检查（API/Worker/Web）与模块相关单测通过；子路径 `/gait/` 下刷新与深链实测正常 |
| 2026-11-23 | 平台元数据库由 SQLite 全量替换为 PostgreSQL：驱动改 `pg`、仓储异步化、FTS5 改 `search_text` + `ILIKE`、任务队列 `SKIP LOCKED`、checkpoint 迁移独立库 `PostgresSaver`、备份恢复改 `pg_dump`/`pg_restore`、Docker/CI/环境变量同步；同时修复并发、越权、错误泄漏与通知重复发送等审查问题 | M11-S1 | 不迁移存量 SQLite 数据；迁移后重新初始化数据库；90 测试文件/424 单测通过；覆盖率 81.30% 行；lint/format/typecheck/build/check:deps/check:security/audit:prod 通过；真实 PG E2E 与备份恢复待部署机补验 |
| 2026-11-21 | 新增 `docs/DEPLOYMENT.md` 完整部署手册与 `docs/CONFIGURATION.md` 配置手册，覆盖 Docker/非容器部署、外部环境、备份恢复、升级、安全、排障及全部配置项 | 文档 | 同步 README 文档索引；无代码/接口/进度变化 |
| 2026-11-21 | 新增 PostgreSQL 迁移导出、环境组、配额/用量、CI/PR 回写、S3 归档、OIDC SSO、Runner 注册与心跳、插件 step；M10 全步骤完成，总体进度 100.0% | M10 | 89 测试文件、410 单测通过；覆盖率 80.96% 行；E2E 5 passed；迁移 0009/0010 通过；平台元数据仍 SQLite，真实云服务/Docker/跨进程锁为已知约束 |
| 2026-11-21 | 新增 Midscene 适配/`[agent]` 视觉步骤、LLM 修复提案与自动应用/审批/回滚、基线环境 A/B、Run/Generation SSE、项目访问与成员、Graph C 文档与 T0-T3/FTS、Webhook/部署/定时触发器与影响面选测；M9 全步骤完成并退出验收，总体进度 87.0% | M9 | 85 测试文件、398 单测通过；覆盖率 81.77% 行；E2E 5 passed；迁移 0008 双跑通过；真实 Midscene/Docker/外部 CI 待补验；下一步 M10-S1 |
| 2026-11-21 | 新增 `examples/demo-app`、安全响应头与 API 限流、`/readyz`/`/metrics`、Worker 心跳、SQLite 备份恢复、Docker/Compose/Nginx、P0 验收报告、smoke 脚本与 v0.1.0 发布物；M8 全步骤完成并退出验收，总体进度 60.0% | M8 | 76 测试文件、368 单测通过；覆盖率 86.89% 行；E2E 4 passed；check:security/audit:prod 通过；Docker 与外部部署演练需部署机补做；下一步 M9-S1 |
| 2026-11-21 | 新增 GitHub 风格 Web 基座、项目/设置/生成审批/运行详情/证据/用例/审计页面；新增 `feature-files`/`cases`/产物下载 API；Playwright E2E 使用独立种子 API 与本地 bare Suite；M7 全步骤完成并退出验收，总体进度 55.0% | M7 | 72 测试文件、359 单测通过；覆盖率 86.99% 行；E2E 4 passed（登录/配置/生成审批/运行证据/跨租户）；lint/typecheck/build/check:deps/E2E 通过；下一步 M8-S1 |
| 2026-11-21 | 新增 `repair_attempts`/`notifications` 迁移与仓储；新增证据包（步骤/日志/产物/diff/历史/feature 源码）、规则与 LLM 归因、失败重跑 flaky、修复 guard、JSON/Markdown/HTML/JUnit 报告、飞书卡片通知与幂等重试；Graph B 增加 rerun/analyze/report/notify；新增报告与通知 API；M6 全步骤完成并退出验收，总体进度 50.0% | M6 | 72 测试文件、358 单测通过；覆盖率 86.86% 行；code_bug/test_bug 可区分；失败 Run 重跑 attempt=2 + 4 个报告产物；lint/typecheck/build/check:deps/E2E/audit:prod 通过；下一步 M7-S1 |
| 2026-11-20 | 新增 `runs`/`run_cases`/`step_results`/`artifacts`/`run_events` 迁移与仓储；新增 `packages/runner` 工作区、环境校验、DB 适配器/fixtures、HTTP/DB/UI/脚本步骤、Graph B、并发/取消/产物；新增 Run API 与 Worker `run.execute`；M5 全步骤完成并退出验收，总体进度 43.0% | M5 | 67 测试文件、301 单测通过；覆盖率 87.30% 行；50 条 API 场景测试通过；真实 Chromium UI 截图/Trace；lint/typecheck/build/check:deps/E2E 通过；下一步 M6-S1 |
| 2026-11-20 | 新增 `generations`/`generation_files`/`feature_files`/`test_cases` 迁移、FTS5 索引与 generation 仓储；新增 `packages/git` 镜像/diff/过滤/SuiteRepository、`packages/runner` Gherkin/StepRegistry、`packages/agent` LLMFactory/Graph A、Worker 生成 handler、生成审批 API；M4 全步骤完成并退出验收，总体进度 32.0% | M4 | 54 测试文件、250 单测通过；覆盖率 89.16% 行；3 提交生成 10 场景 100% 校验通过；提交幂等；lint/typecheck/build/check:deps/format/audit:prod/E2E 通过；下一步 M5-S1 |
| 2026-11-20 | 新增 `credentials`/`projects`/`llm_profiles`/`environments`/`notification_channels` 迁移与仓储；项目 CRUD、Git 凭据加密与连通性测试、LLM Profile、Environment Profile、飞书通知渠道、SSRF 防护、生产库拒绝、危险开关二次确认与配置审计；M3 全步骤完成并退出验收，总体进度 21.0% | M3 | 43 测试文件、205 单测通过；覆盖率 90.42% 行；加密落库明文扫描通过；跨租户配置 404；lint/typecheck/build/check:deps/format/audit:prod/E2E 通过；下一步 M4-S1 |
| 2026-11-20 | 新增 `users`/`tenant_members`/`sessions`/`audit_logs` 迁移与仓储；argon2id 登录、会话/CSRF/限流、RBAC 守卫、成员管理、审计 API、`admin:create` CLI、React 登录页与租户切换；M2 全步骤完成并退出验收，总体进度 14.0% | M2 | 29 测试文件、142 单测通过；覆盖率 92.55% 行；GUI 登录/切换/退出实测；lint/typecheck/build/check:deps/format/E2E 通过；下一步 M3-S1 |
| 2026-11-20 | M1 退出验收通过：迁移幂等、Worker noop 消费、checkpoint 库分离、`/healthz` 200；88 单测与 lint/format/typecheck/build/check:deps/audit:prod 通过；CI verify 与 e2e 全绿（run `44720997206`、commit `6c34530`）；M1 标记 DONE，总体进度 8.0% | M1 | 下一步 M2-S1 |
| 2026-11-20 | 复验显示 Install Chromium 已成功（`--with-deps` 未回退，判断首次为瞬时失败），但 `Run E2E` 失败；补充捕获 E2E 输出并在失败时以 `::error::` 注解暴露日志尾部；本地 `CI=true pnpm test:e2e` 通过 | M1-S7 | verify 作业通过；后续复验 E2E 通过，判断为瞬时失败；保留失败日志注解便于再次定位 |
| 2026-11-20 | E2E 回退安装仍在约 2 秒内失败；补充捕获两个安装命令的输出，失败时输出日志尾部并通过 `::error::` 注解暴露具体报错，便于定位根因 | M1-S7 | verify 作业已通过；e2e 作业仍失败于 Install Chromium，等待诊断复验 |
| 2026-11-20 | CI E2E 作业的 `playwright install --with-deps` 在 GitHub Runner 上快速失败；增加 Playwright CLI 版本输出、失败告警与仅安装浏览器的回退，保留 `--with-deps` 优先 | M1-S7 | M1 退出验收期间发现；verify 作业（lint/typecheck/test/build/check:deps/audit:prod）已通过；回退后 e2e 仍失败 |
| 2026-11-20 | 新增 `check:progress` 门禁脚本（staged / `--base`）、husky pre-commit 与 `prepare`、CI PR 进度校验、PR 模板；`audit` 脚本更名 `audit:prod` 避免与 pnpm 内置命令同名；M1-S8 完成 | M1-S8 | 未同步进度文档的暂存改动被拦截（退出码 1）；补登后通过；lint/typecheck/format/test/build/check:deps/audit:prod 通过；code-review 通过（无 medium 及以上问题） |
| 2026-11-20 | 新增 Vitest 覆盖率配置与阈值、Playwright 配置与 Chromium 冒烟用例、GitHub Actions CI（verify + e2e）、`test:coverage`/`test:e2e`/`audit:prod` 脚本；M1-S7 完成 | M1-S7 | 88 个单测通过；覆盖率 92.14% 行 / 93.04% 函数 / 77.62% 分支；E2E 本地通过；audit 无已知漏洞；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| 2026-11-20 | 新增 `jobs` 表与迁移、`JobQueue`（原子领取/心跳/完成/重试/过期回收/去重）、Worker 轮询与 handler 注册、租约丢失中止、优雅退出、LangGraph checkpoint 独立库与启动路径校验、`.env` 向上查找；M1-S6 完成 | M1-S6 | 86 个单测通过；实际进程消费 noop 验证通过；checkpoint 库分离验证通过；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| 2026-11-20 | 新增 Fastify 应用工厂、`/healthz`、请求 ID 校验与回写、RFC 7807 统一错误、Cookie 插件、CSRF double-submit 工具/守卫、无查询串访问日志与幂等优雅退出；M1-S5 完成 | M1-S5 | `curl` 健康检查/404 验证通过；60 个单测通过；build/typecheck/check:deps/lint/format 通过；code-review 通过（无 medium 及以上问题） |
| 2026-11-20 | 新增 Drizzle schema 基座（tenants 根表）、初始迁移、SQLite PRAGMA、迁移 CLI、Repository 基类与临时测试库 helper；M1-S4 完成 | M1-S4 | `db:migrate` 重复执行通过；WAL/外键/busy_timeout 校验通过；41 个单测通过 |
| 2026-11-20 | 新增环境校验、pino 日志脱敏、RFC 7807 错误、AES-256-GCM 凭据加密、UUIDv7 与时间工具；统一环境变量命名；M1-S3 完成 | M1-S3 | 33 个单测通过；build/typecheck/check:deps/lint/format 通过 |
| 2026-11-20 | 建立 3 个应用与 7 个共享包骨架、TS project references、Web Vite 基座与 dependency-cruiser 依赖边界；M1-S2 完成 | M1-S2 | 干净状态下 build/typecheck/check:deps/lint/format 通过 |
| 2026-11-20 | 初始化 pnpm workspace、TS/ESLint/Prettier、环境模板与工作区校验脚本；M1-S1 完成 | M1-S1 | lint/typecheck/format/verify 通过 |
| 2026-11-20 | 初始化开发进度文档；M0 完成，总体进度 2.0% | M0-S3 | 下一步 M1-S1 |
| 2026-11-20 | 规格第 22 章增加开发计划/进度链接 | M0-S1 | 提升文档可发现性 |
| 2026-11-20 | 文档 v0.2：改为对已部署测试环境执行，解除语言/框架限制 | M0-S1、M0-S2 | commit `96868cc` |
| 2026-11-20 | 文档初版：24 章规格与 3 个示例 feature | M0-S1、M0-S2 | commit `5736cb7` |

---

## 6. 下一步行动

1. **部署环境验收**：真实 S3、OIDC IdP、GitHub/GitLab、Docker Compose、外部 demo CI/CD、真实 Midscene 视觉模型、真实飞书/LLM/MySQL/PostgreSQL。
2. **P2 约束收敛**：跨进程分布式环境锁、SSO 单点登出/密钥轮换、进程内限流的共享存储。
3. **维护**：依赖升级、antd 6 弃用 API、Web chunk 拆分、移动端只读视图、监控指标扩展。
4. **社区/发布**：0.3.0 tag/Release Notes、示例 Suite 仓库、插件开发文档。

> 每个步骤开始前将状态改为 `DOING`；完成后补测试、文档、进度，再提交。

---

## 7. 阻塞与关注项

| 项 | 状态 | 说明 | 应对 |
|---|---|---|---|
| 外部环境版本一致性 | 已缓解 | 测试环境可能未部署到目标 `headSha` | M5 每次 Run 解析/记录 `deployedSha`；`strictVersionMatch=true` 阻断；报告展示目标/实际版本 |
| PostgreSQL 写并发 | 已缓解 | 队列、Run、RunCase、事件并发写 | 任务领取 `FOR UPDATE SKIP LOCKED`、事件 seq 行锁、连接池与租约；事务保持短小 |
| Worker 多 Run 并发 | 关注 | M5 环境互斥为进程内锁，Worker 单作业消费 | 多 Runner 水平扩展与分布式环境锁留 M10-S6 |
| LLM 生成质量 | 关注 | 生成不可执行或重复用例 | StepRegistry 干跑、规则校验、critique、去重 |
| LLM 归因误判 | 已缓解 | 无证据或低置信度给出错误分类 | 规则优先 + 证据引用白名单 + 置信度阈值 + `unknown` 回退 + 人工复核；M6 不自动修复 |
| 通知风暴 | 已缓解 | 失败用例多导致逐条通知 | 按 Run 汇总、`dedupe_key` 幂等、最多 3 次重试、卡片只放摘要 |
| P0 修复范围 | 已约束 | 自动改测试迁就 Bug | M6 仅生成 `human_required` 建议；apply/rerun 与审批留 M9 |
| UI 选择器稳定性 | 关注 | 前端改动导致用例失败 | 确定性步骤优先；P1 Midscene 兜底 |
| GUI 实时性 | 已约束 | P0 轮询而非 SSE | 生成/运行 3–5 秒轮询；SSE 断线续传留 M9-S4 |
| 用例在线编辑 | 已约束 | M7 只做索引与元数据查看 | 场景正文仍由 Suite Git 管理；在线编辑与文档管理留 P1/M9-S6 |
| antd 6 弃用警告 | 关注 | `Alert.message`、`Statistic.valueStyle`、`Drawer.width`、`List` 提示弃用 | 功能不受影响；升级 antd 或下一次 UI 重构时统一替换 |
| Docker 部署未实机演练 | 已记录 | 本开发机无 Docker，Compose 仅完成配置与静态检查 | 部署机执行 `docker compose up -d --build`、`/readyz` 与恢复演练 |
| 真实外部环境验收 | 已记录 | 未提供外部 demo 部署、真实飞书/LLM/MySQL/PostgreSQL | 提供 demo-app、`pnpm smoke:p0` 与验收清单；在用户环境补验 |
| 真实视觉 Agent | 已记录 | Midscene 依赖与视觉模型未安装，测试使用注入替身 | 安装 `@midscene/web` 并配置 vision LLM Profile 后执行 M9 验收 |
| 自动验证 Run | 已缓解 | 修复审批后自动创建单场景 Run，但重复审批不会重复创建 | 若队列失败，修复已提交且审计记录 `rerunRunId=null`，可手工新建 Run |
| 平台元数据库 | 已完成 | M11-S1 已由 SQLite 迁移到 PostgreSQL；不再维护 SQLite 运行时 | 使用 `DATABASE_URL`/`CHECKPOINT_DATABASE_URL`；迁移后重新初始化，不迁移存量 SQLite 数据 |
| PostgreSQL client tools | 已记录 | 备份/恢复依赖 `pg_dump`/`pg_restore` | 部署机安装 `postgresql-client-17`（大版本需与数据库一致）；缺失时 CLI 给出安装提示 |
| 真实 PostgreSQL E2E | 已记录 | 本机无 Docker/psql，`pnpm test:e2e` 与备份恢复未在真实 PG 上执行 | CI 使用 `postgres:17-alpine`；部署机执行 E2E 与 `pg_dump`/`pg_restore` 演练 |
| 多 Runner 环境锁 | 已知约束 | 任务领取原子，但环境互斥仍为进程内 | 多容器同环境需部署层串行或后续分布式锁 |
| 真实云服务 | 已记录 | S3/OIDC/CI 使用注入 HTTP 测试 | 部署环境使用真实服务做连通性验收 |
| P0-P2 范围较大 | 已完成 | 83/83 步骤完成 | 后续维护与外部环境验收 |

当前无阻塞项。

---

## 8. 提交前检查清单

每次 `git commit` 前逐项确认：

- [ ] 本次提交已关联 Step ID（commit message 含 `[Mx-Sy]`）。
- [ ] 对应 Step 状态已更新（`DOING` / `VERIFY` / `DONE`）。
- [ ] 已填写日期、commit（未提交可写「本次提交」）、验证结果/备注。
- [ ] 里程碑进度与总体进度已重算。
- [ ] 「最近提交」与「变更日志」已更新；纯文档提交也要登记一行。
- [ ] 若接口/配置/数据模型/执行行为变化，`PROJECT_SPEC.md` 已同步。
- [ ] 若步骤/范围变化，`DEVELOPMENT_PLAN.md` 已同步并升级版本。
- [ ] 已运行适用的 `pnpm lint`、`pnpm typecheck`、`pnpm test`，或注明不适用原因。
- [ ] 无明文密钥、无敏感日志、无跨租户越权。
- [ ] 进度文档与代码在同一个 commit 中提交。

---

## 9. 维护规则

1. **唯一事实源**：进度只在本文件维护；`README.md`、Issue、PR 描述可引用，但不得另建进度表。
2. **更新时机**：每次提交前更新；禁止「先提交、后补进度」。
3. **同一 commit**：进度文档必须与本次代码/文档改动一起提交；由 husky pre-commit 与 CI PR 门禁（`pnpm check:progress`）自动校验。
4. **状态严格**：
   - `DONE` 必须有验证结果；
   - `VERIFY` 不计入进度；
   - `BLOCKED` 必须写明阻塞原因、责任人和解除条件；
   - 不得用 `DONE` 标记「代码写完但没测」。
5. **步骤拆分**：一个 Step 跨多次提交时保持 `DOING`，在备注中记录已完成子项；全部完成并验证后再改 `DONE`。
6. **范围变更**：新增/删除 Step 必须先在 `DEVELOPMENT_PLAN.md` 修改并升级版本，再更新本文件；保留变更记录。
7. **权重调整**：里程碑权重只能通过开发计划版本升级调整；调整后重算历史基线，不追溯修改旧记录。
8. **提交信息**：`<type>(<scope>): <subject> [Mx-Sy]`；纯文档/杂项用 `docs(m0): ... [M0-S3]` 或 `chore: ... [Mx-Sy]`。
9. **发布冻结**：发布前将对应里程碑全部标记 `DONE`，并附验收报告链接/记录；未完成项转入下一里程碑。
10. **审计**：每季度或每个大版本回顾一次进度准确性，修正长期 `DOING`/`BLOCKED` 项。

---

## 10. 关联文档

- [开发项目描述文档](./PROJECT_SPEC.md)
- [开发阶段与实施步骤](./DEVELOPMENT_PLAN.md)
- [登录流程用例示例](./examples/login.feature)
- [Agent 复杂流程用例示例](./examples/instagram-post.feature)
- [API + 数据库断言用例示例](./examples/post-api.feature)
