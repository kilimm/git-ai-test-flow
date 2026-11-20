# git-ai-test-flow 开发进度

> 本文是开发进度的**唯一事实源**。每次提交前必须更新，并与代码放入同一个 commit。
>
> 开发步骤、依赖与验收标准见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)；产品设计见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。

## 1. 当前状态

| 项 | 当前值 |
|---|---|
| 更新日期 | 2026-11-20 |
| 当前阶段 | M4 变更分析与用例生成（DONE） |
| 当前步骤 | M4-S10 生成链路测试与验收（DONE） |
| 总体进度 | **32.0%**（M0 2% + M1 6% + M2 6% + M3 7% + M4 10/10 × 11%） |
| 已完成步骤 | 36 / 83 |
| 最近提交 | 本次提交 `feat(m4): 完成变更分析与用例生成` |
| 本次变更 | `feat(m4): 完成变更分析与用例生成 [M4]` |
| 阻塞项 | 无 |
| 下一步 | 开始 M5-S1（Run 工作区） |

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
| M5 执行引擎 | P0 | 11% | 10 | 0 | 0% | TODO |
| M6 归因/报告/通知 | P0 | 7% | 9 | 0 | 0% | TODO |
| M7 GUI 基础闭环 | P0 | 5% | 7 | 0 | 0% | TODO |
| M8 P0 验收与加固 | P0 | 5% | 6 | 0 | 0% | TODO |
| M9 P1 增强 | P1 | 27% | 8 | 0 | 0% | TODO |
| M10 P2 扩展 | P2 | 13% | 7 | 0 | 0% | TODO |
| **合计** | - | **100%** | **83** | **36** | **32.0%** | - |

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
| M5-S1 | Run 工作区 | TODO | - | - | Suite worktree、只读产品源码、清理 |
| M5-S2 | 环境健康与版本校验 | TODO | - | - | healthcheck、deployedSha、strict |
| M5-S3 | DB 适配器与 fixtures/护栏 | TODO | - | - | MySQL/PostgreSQL/SQLite、写入护栏 |
| M5-S4 | HTTP 执行器与断言 | TODO | - | - | 状态/JSONPath/JSON Schema/头 |
| M5-S5 | DB 步骤与断言 | TODO | - | - | 参数化查询、行数/结果集 |
| M5-S6 | StepRegistry 与内置步骤 | TODO | - | - | builtin/template/script/api/db/ui |
| M5-S7 | Run 编排/并发/取消/超时 | TODO | - | - | 环境互斥、AbortController |
| M5-S8 | 产物采集与脱敏 | TODO | - | - | API/DB/截图/Trace/console |
| M5-S9 | Graph B 执行主链 | TODO | - | - | prepare→verify→discover→run |
| M5-S10 | API/DB/基础 UI 端到端验收 | TODO | - | - | 50 条 API ≤ 15 分钟 |

### 3.7 M6 归因、报告与飞书（P0，7%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M6-S1 | 证据包构建与脱敏 | TODO | - | - | Step/API/DB/日志/diff |
| M6-S2 | 规则归因引擎 | TODO | - | - | 规格 13.2 全矩阵 |
| M6-S3 | LLM 归因与结构化输出 | TODO | - | - | 证据引用、置信度、unknown 回退 |
| M6-S4 | flaky 重跑判定 | TODO | - | - | 失败重跑 1 次 |
| M6-S5 | 修复建议与 guard | TODO | - | - | P0 仅建议，不改产品代码 |
| M6-S6 | 报告生成与导出 | TODO | - | - | JSON/Markdown/HTML/JUnit |
| M6-S7 | 飞书通知与幂等 | TODO | - | - | 签名、卡片、去重、重试 |
| M6-S8 | Graph B 归因/报告/通知闭环 | TODO | - | - | classify→decide→report→notify |
| M6-S9 | 归因/报告/通知测试 | TODO | - | - | code_bug/test_bug 可区分 |

### 3.8 M7 GUI 基础闭环（P0，5%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M7-S1 | 设计 token 与 Web 基座 | TODO | - | - | GitHub 风格、路由、API client |
| M7-S2 | 登录/租户切换/权限态 | TODO | - | - | 会话守卫、RBAC UI |
| M7-S3 | 项目与设置页面 | TODO | - | - | 通用/凭据/LLM/环境/飞书/审计 |
| M7-S4 | 生成与审批页面 | TODO | - | - | 功能点、diff、审批/编辑 |
| M7-S5 | 运行列表/详情/证据 | TODO | - | - | 用例时间线、截图/Trace |
| M7-S6 | 用例/文档占位/审计页面 | TODO | - | - | 筛选、详情跳转 |
| M7-S7 | GUI E2E | TODO | - | - | `pnpm test:e2e` 通过 |

### 3.9 M8 P0 验收与加固（P0，5%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M8-S1 | demo-app 预部署与版本接口 | TODO | - | - | 外部 CI 部署、版本接口 |
| M8-S2 | 安全加固 | TODO | - | - | SSRF/路径穿越/prompt injection |
| M8-S3 | 性能与容量 | TODO | - | - | p95 ≤ 500ms、50 条 ≤ 15 分钟 |
| M8-S4 | 部署/备份/迁移 | TODO | - | - | Docker Compose、恢复演练 |
| M8-S5 | P0 验收与指标 | TODO | - | - | 规格 21.2/21.3 |
| M8-S6 | 发布 v0.1.0 | TODO | - | - | CHANGELOG、tag、已知问题 |

### 3.10 M9 P1 增强（P1，27%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M9-S1 | Midscene UI 视觉测试 | TODO | - | - | aiAct/aiAssert、截图对比 |
| M9-S2 | 自修复循环与 guard | TODO | - | - | 审批/回滚/quarantine |
| M9-S3 | 历史基线与多环境 A/B | TODO | - | - | baselineEnvironmentId |
| M9-S4 | SSE 事件流 | TODO | - | - | 生成/运行事件、断线重连 |
| M9-S5 | 项目级 RBAC | TODO | - | - | 项目成员与权限 |
| M9-S6 | 文档生成/增量/压缩 | TODO | - | - | Graph C、T0-T3、FTS5 |
| M9-S7 | Webhook/定时/影响面选测 | TODO | - | - | 幂等、恢复、选测 |
| M9-S8 | Docker runner 与 P1 验收 | TODO | - | - | P1 退出标准 |

### 3.11 M10 P2 扩展（P2，13%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M10-S1 | PostgreSQL 支持 | TODO | - | - | 双库集成测试 |
| M10-S2 | 多环境管理 | TODO | - | - | 环境分组/基线/配额 |
| M10-S3 | CI/PR 集成 | TODO | - | - | 触发与报告回写 |
| M10-S4 | S3/对象存储产物 | TODO | - | - | 上传/下载/保留 |
| M10-S5 | 配额计费与 SSO | TODO | - | - | 配额阻断、SSO |
| M10-S6 | 多 runner 水平扩展 | TODO | - | - | 注册/租约/调度 |
| M10-S7 | 插件化 step 与 P2 验收 | TODO | - | - | 第三方 step 加载 |

---

## 4. 最近提交

| 日期 | Commit | 类型 | 摘要 | 关联 Step |
|---|---|---|---|---|
| 2026-11-20 | 本次提交 | feat(m4) | 完成变更分析、用例生成、审批与 Suite 提交 | M4-S1 ~ M4-S10 |
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

1. **M3-S1 启动**：项目 CRUD、slug 唯一、Suite 模式与租户隔离，沿用 M2 的会话派生 `tenant_id` 与 404 隔离策略。
2. **前端衔接**：项目列表/设置入口随 M3 API 补齐，设计 token 与完整 GUI 留到 M7。

> 每个步骤开始前将状态改为 `DOING`；完成后补测试、文档、进度，再提交。

---

## 7. 阻塞与关注项

| 项 | 状态 | 说明 | 应对 |
|---|---|---|---|
| 外部环境版本一致性 | 关注 | 测试环境可能未部署到目标 `headSha` | M5-S2 强制解析/记录 `deployedSha`；严格模式阻断 |
| SQLite 写并发 | 关注 | 队列、Run、审计并发写 | WAL、`busy_timeout`、单写队列、租约 |
| LLM 生成质量 | 关注 | 生成不可执行或重复用例 | StepRegistry 干跑、规则校验、critique、去重 |
| UI 选择器稳定性 | 关注 | 前端改动导致用例失败 | 确定性步骤优先；P1 Midscene 兜底 |
| P0 范围较大 | 关注 | 8-10 周交付压力 | 严格按里程碑推进；P1 能力不提前 |

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
