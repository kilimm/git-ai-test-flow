# git-ai-test-flow 开发进度

> 本文是开发进度的**唯一事实源**。每次提交前必须更新，并与代码放入同一个 commit。
>
> 开发步骤、依赖与验收标准见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)；产品设计见 [PROJECT_SPEC.md](./PROJECT_SPEC.md)。

## 1. 当前状态

| 项 | 当前值 |
|---|---|
| 更新日期 | 2026-11-20 |
| 当前阶段 | M1 工程基座（进行中） |
| 当前步骤 | M1-S4 数据库 schema、迁移与测试库（下一步） |
| 总体进度 | **4.25%**（M0 2% + M1 3/8 × 6%） |
| 已完成步骤 | 6 / 83 |
| 最近提交 | `363cb7b` chore(m1): 建立应用与共享包骨架 [M1-S2] |
| 本次变更 | `feat(m1): 新增配置、日志、错误与加密基础库 [M1-S3]` |
| 阻塞项 | 无 |
| 下一步 | M1-S4：Drizzle schema、SQLite 迁移与测试库 |

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
| M1 工程基座 | P0 | 6% | 8 | 3 | 37.5% | DOING |
| M2 认证与租户 | P0 | 6% | 8 | 0 | 0% | TODO |
| M3 项目与配置 | P0 | 7% | 7 | 0 | 0% | TODO |
| M4 变更分析与用例生成 | P0 | 11% | 10 | 0 | 0% | TODO |
| M5 执行引擎 | P0 | 11% | 10 | 0 | 0% | TODO |
| M6 归因/报告/通知 | P0 | 7% | 9 | 0 | 0% | TODO |
| M7 GUI 基础闭环 | P0 | 5% | 7 | 0 | 0% | TODO |
| M8 P0 验收与加固 | P0 | 5% | 6 | 0 | 0% | TODO |
| M9 P1 增强 | P1 | 27% | 8 | 0 | 0% | TODO |
| M10 P2 扩展 | P2 | 13% | 7 | 0 | 0% | TODO |
| **合计** | - | **100%** | **83** | **6** | **4.25%** | - |

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
| M1-S3 | 配置/日志/错误/加密基础库 | DONE | 2026-11-20 | 本次提交 | 环境校验、pino 脱敏、RFC 7807、AES-256-GCM、UUIDv7；33 个单测通过；build/typecheck/check:deps/lint/format 通过 |
| M1-S4 | 数据库 schema、迁移与测试库 | TODO | - | - | Drizzle、WAL、外键、迁移可重复 |
| M1-S5 | Fastify API 骨架 | TODO | - | - | `/healthz`、请求 ID、优雅退出 |
| M1-S6 | Worker 骨架与任务队列 | TODO | - | - | 租约/心跳、checkpoint 初始化 |
| M1-S7 | 测试与 CI 基线 | TODO | - | - | Vitest、Playwright、GitHub Actions |
| M1-S8 | 进度同步门禁 | TODO | - | - | `pnpm check:progress`、hook、PR 模板 |

### 3.3 M2 认证与租户（P0，6%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M2-S1 | 租户/用户/会话/成员表与仓储 | TODO | - | - | tenant 过滤单测 |
| M2-S2 | 登录/登出/当前用户/改密 | TODO | - | - | argon2id、Cookie、CSRF |
| M2-S3 | 首个管理员 CLI | TODO | - | - | `pnpm admin:create` |
| M2-S4 | RBAC 权限矩阵与守卫 | TODO | - | - | 四角色矩阵测试 |
| M2-S5 | 租户成员管理 | TODO | - | - | 最后 OWNER 保护 |
| M2-S6 | 审计日志 | TODO | - | - | 登录/切租户/成员变更 |
| M2-S7 | 跨租户与安全集成测试 | TODO | - | - | 跨租户 100% 404 |
| M2-S8 | 最小登录页与应用外壳 | TODO | - | - | 登录、租户切换 |

### 3.4 M3 项目与配置（P0，7%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M3-S1 | 项目 CRUD | TODO | - | - | slug 唯一、Suite 模式 |
| M3-S2 | Git 凭据与测试连接 | TODO | - | - | AES-GCM、掩码、`git ls-remote` |
| M3-S3 | LLM Profile 与连通性测试 | TODO | - | - | 四用途、健康状态 |
| M3-S4 | Environment Profile | TODO | - | - | URL、健康检查、版本来源、DB |
| M3-S5 | 飞书渠道与测试卡片 | TODO | - | - | 签名、事件选择 |
| M3-S6 | 配置校验/脱敏/审计 | TODO | - | - | 生产库拒绝、危险开关 |
| M3-S7 | 配置模块集成测试 | TODO | - | - | 租户隔离、加密落库 |

### 3.5 M4 变更分析与用例生成（P0，11%）

| Step | 内容 | 状态 | 日期 | 提交 | 验证/备注 |
|---|---|---|---|---|---|
| M4-S1 | Git mirror/worktree/diff | TODO | - | - | `current/range`、`--unified=3` |
| M4-S2 | 文件过滤与变更分类 | TODO | - | - | 锁文件/二进制/文档/OpenAPI |
| M4-S3 | 功能点提取与聚合 | TODO | - | - | 源码引用、风险级别 |
| M4-S4 | Suite 仓库抽象 | TODO | - | - | managed/external/same_repo |
| M4-S5 | Gherkin 解析/StepRegistry 干跑 | TODO | - | - | Tag、`[agent]`、变量插值 |
| M4-S6 | 已有用例检索与覆盖判断 | TODO | - | - | FTS5、内容哈希、场景指纹 |
| M4-S7 | Graph A 生成工作流 | TODO | - | - | 中断审批、checkpoint 恢复 |
| M4-S8 | 校验器与 critique 重写 | TODO | - | - | 语法/step/tag/secret/重复/断言 |
| M4-S9 | 审批 API 与 Suite 提交 | TODO | - | - | diff 预览、approve/edit/reject |
| M4-S10 | 生成链路测试与验收 | TODO | - | - | 3 提交 ≥ 10 场景 |

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
| 2026-11-20 | 本次提交 | feat(m1) | 新增配置、日志、错误与加密基础库 | M1-S3 |
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
| 2026-11-20 | 新增环境校验、pino 日志脱敏、RFC 7807 错误、AES-256-GCM 凭据加密、UUIDv7 与时间工具；统一环境变量命名；M1-S3 完成 | M1-S3 | 33 个单测通过；build/typecheck/check:deps/lint/format 通过 |
| 2026-11-20 | 建立 3 个应用与 7 个共享包骨架、TS project references、Web Vite 基座与 dependency-cruiser 依赖边界；M1-S2 完成 | M1-S2 | 干净状态下 build/typecheck/check:deps/lint/format 通过 |
| 2026-11-20 | 初始化 pnpm workspace、TS/ESLint/Prettier、环境模板与工作区校验脚本；M1-S1 完成 | M1-S1 | lint/typecheck/format/verify 通过 |
| 2026-11-20 | 初始化开发进度文档；M0 完成，总体进度 2.0% | M0-S3 | 下一步 M1-S1 |
| 2026-11-20 | 规格第 22 章增加开发计划/进度链接 | M0-S1 | 提升文档可发现性 |
| 2026-11-20 | 文档 v0.2：改为对已部署测试环境执行，解除语言/框架限制 | M0-S1、M0-S2 | commit `96868cc` |
| 2026-11-20 | 文档初版：24 章规格与 3 个示例 feature | M0-S1、M0-S2 | commit `5736cb7` |

---

## 6. 下一步行动

1. **M1-S4 数据库基座**：Drizzle schema、迁移、SQLite PRAGMA、测试库。
2. **M1-S5 API 骨架**：`/healthz`、请求 ID、错误处理、优雅退出。
3. **M1-S6 Worker 骨架**：`jobs` 表、租约/心跳、checkpoint 初始化。
4. **M1-S7 测试与 CI**：Vitest、Playwright、GitHub Actions、覆盖率与依赖审计。
5. **M1-S8 进度门禁**：`pnpm check:progress`、hook、PR 模板。

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
3. **同一 commit**：进度文档必须与本次代码/文档改动一起提交；CI 门禁（M1-S8）上线后自动校验。
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
