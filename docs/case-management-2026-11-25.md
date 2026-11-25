# 用例管理增强（2026-11-25）

三项功能已实现并部署到 http://111.228.50.95/gait/ 。

## 1. 用例在线编辑 + step 快捷输入
- **入口**：项目 → 用例管理（原「用例索引」页重构）。在线编辑 feature 与数据文件（features/**、schemas/、templates/、fixtures/）。
- **存储分流**：repo 模式提交到 Suite Git（`writeAndCommit`），db 模式写 `case_blobs`；保存后自动重建索引。
- **step 快捷补全**（`apps/web/src/components/StepEditor.tsx`）：光标落在 Given/When/Then 行时，
  用脚本库 34 条 step 的 pattern 做前缀匹配（占位符展开成正则），点击候选会把整行替换为示例句式，
  光标定位到第一个占位符；支持撤销与快捷关键字切换。
- **API**：`GET/PUT /projects/:id/case-files`（带 repo/db 两侧状态与解析结果）。

## 2. 模块目录树与模块管理
- **模块树**：`GET /projects/:id/case-modules`，按 `@module` 标签聚合（点分层级，父节点累计数）。
- **改用例模块**：`POST /projects/:id/case-files/move-module` —— 重写 feature 级 @module（决定文件归属）
  + 场景级 @module 统一。
- **模块增删改**：`POST /projects/:id/case-modules/edit`
  - `rename`：前缀精确匹配重写（`ui.form` → `ui.upload`，同时处理子模块），目标已存在则 409；
  - `delete`：`deleteCases=true` 整文件删除（纯属该模块）或删除对应场景块；`false` 改为 `unknown`。
  - 新增模块在前端生成 feature 骨架（路径 `features/<key 点转 />.feature`）交编辑器保存。
- **⚠️ 修复**：`packages/runner/src/gherkin/index.ts` 的 `moduleOf` 原正则不允许点号，
  导致 `@module:api.messages` 类层级模块被索引成 `unknown`。改为 `[A-Za-z0-9_][A-Za-z0-9_.-]*`。

## 3. 提示词统一管理与额外需求
- **提示词管理页**：项目设置 → 提示词（`tenants:update` 权限）。4 个阶段（summarize/extract/design/critique）
  直接编辑内置默认系统提示词；留空或与默认一致 = 恢复默认（`PUT /prompt-templates/:stage`）。
- **额外需求**：「新建生成任务」「一键生成初始用例集」表单新增「额外需求」文本域
  （如「请确保用户上传的图片不超过 500*500」）。持久化在 `generations.stats.extraInstructions`，
  以 `<user_requirement>` 块注入四个阶段提示词，排序在默认策略之后、明确要求“冲突时以本需求为准”。
- **接线修复**：`apps/worker/src/generation-handler.ts` 之前**从未**读取提示词覆盖，
  租户自定义提示词完全没生效；现已读取并注入 `promptOverrides`，并在 awaiting_approval / failed
  回写 stats 时保留 `extraInstructions`。

## 验证
- `tsc -b`（server/worker/agent/runner/git）通过；`pnpm --filter @gait/web typecheck` 通过；
  `eslint` 关键文件 0 报错；`depcruise` 无违规（修复了 prompts↔types 循环依赖，`PromptOverrides` 移到 types.ts）；
  `check:security`、`check:progress` 通过。
- 单测：gherkin / agent workflow / suite-repository（新增 deleteAndCommit 用例）/ worker generation-handler /
  server generations 共 38 passed。
- 线上实测（message-board 项目）：保存新 feature → 建模块树 → move-module → rename → delete(unknown) →
  delete(cases) 全部成功；提示词保存/恢复默认成功；带 extraInstructions 的 baseline 生成进入 awaiting_approval，
  产出 `image-limits.feature`（500x500 边界断言）等 4 个用例。

## 遗留
- 删除操作当前是「提交后清理」，未做 Git 历史回滚入口。
- 模块树的「新增模块」只在前端生成骨架，真正落库依赖保存；
- step 补全只按已输入前缀过滤，未做语义排序（按关键字命中优先级粗排）。
