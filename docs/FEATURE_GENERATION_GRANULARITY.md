# 生成能力增强：颗粒度 / 全量基线 / 模块识别与按模块生成

> 关联：`docs/PROJECT_SPEC.md`（生成流程）、`docs/DEVELOPMENT_PROGRESS.md`（M12-S1）。

## 1. 生成颗粒度（granularity）

`POST /projects/:id/generations` 新增可选字段 `granularity: high | medium | low`，默认 `medium`。

| 颗粒度 | 含义 | 设计提示（注入 design prompt） | 场景数参考 |
|---|---|---|---|
| `high` | 覆盖所有可能出现报错的分支 | 主流程 + 全部错误路径：参数缺失/类型错误/越界/授权失败/资源冲突/依赖异常/并发超时/空数据 | 4-8 / 功能点 |
| `medium` | 只针对核心功能，但穷尽核心功能的全部报错分支 | 主流程 + 核心功能的全部可报错分支 | 2-4 / 功能点 |
| `low` | 只针对核心功能的功能实现主流程分支 | 仅 happy path，省略边界与错误路径 | 1-2 / 功能点 |

实现要点：

- 颗粒度写进 `generations.stats.granularity`（无独立列，避免迁移），幂等 key 包含颗粒度；
- 注入 `summarize / extract / design / critique` 四个 prompt；critique 不会因低颗粒度缺错误路径而误判失败；
- 与模块选择**正交**：`granularity` 决定分支覆盖深度，`selection.modules` 决定范围。

## 2. 全量基线生成（mode=baseline）

**场景**：代码已全部提交、没有可分析的 diff 时，为现有系统建立初始用例集。

- `mode=baseline` 忽略 diff：以 Git 空树（`4b825dc642cb6eb9a060e54bf8d69288fbee4904`）为 base，对目标提交的代码库快照做全量分析；
- 创建时只需 `branch` 或 `headSha`（不允许 `baseSha`）；落库 `baseSha = 空树`，便于追溯；
- 大仓库受 diff 预算约束（单文件 200KB、总量 1.5MB、最多 500 文件）：**不会静默丢文件**，
  `generation.stats` 会给出
  - `filesIncluded` / `filesSkipped` / `filesTruncated`
  - `incomplete: true`（任一文件被跳过/截断/总量截断）
  前端在详情页展示告警，建议缩小模块后分批生成；
- 首页入口：生成页右上角「一键生成初始用例集」（选择颗粒度 / 分支 / 可选 commit / 模块）。

## 3. 模块识别（层级化）

### 3.1 数据模型

模块是**纯派生的逻辑分组**，不新建数据库表：

| 位置 | 字段 | 说明 |
|---|---|---|
| `generation.stats.modules` | `ModuleTreeNode[]` | 本次识别到的模块树（含直接/累计功能点数） |
| `featurePoint.affectedModules` | `string[]` | 功能点所属模块的层级 key，如 `posts.comments` |
| `featurePoint.modulePath` | `string[]` | 祖先链（含自身），如 `posts`, `posts.comments` |
| `summary.modules` | `string[]` | 逐文件摘要的模块 key（规范化后） |

`ModuleTreeNode`：

```ts
interface ModuleTreeNode {
  key: string;          // 完整层级 key：posts.comments
  name: string;         // 末级 slug：comments
  label: string;        // 展示名：Posts / Comments
  parent: string | null;
  featurePoints: number;// 子树（含自身）功能点数
  direct: number;       // 自身直接功能点数
  children: ModuleTreeNode[];
}
```

### 3.2 命名规则（稳定 key，`packages/shared/src/module-tree.ts`）

- 多段分隔符 `. / \ : > #` 与空白 → 层级分隔，统一输出为 `.`；
- 每段转小写，非 `[a-z0-9]` 折叠为 `-`，去首尾 `-`；驼峰拆词（`userProfile` → `user-profile`）；
- 全为中文/符号等无法 slug 的名称 → `general`；
- 例：`Posts/Comments`、`posts > comments`、`Posts.Comments` 全部收敛为 `posts.comments`。

### 3.3 推断来源

1. **LLM**：summarize/extract prompt 明确要求层级 slug（≤3 级），输出仍会规范化；
2. **路径推断**（确定性，`inferModulesFromPath`）：
   - 取文件目录段，跳过脚手架/分层目录（`src/app/apps/packages/lib/server/api/routes/migrations/...`）、隐藏目录、`v1`/`v2` 等版本段；
   - 其他目录段保留最多 3 级组成层级（`src/modules/posts/comments/service.ts` → `posts.comments`）；`modules` 作为容器目录被跳过；
   - 含下划线的目录视为层级（`posts_comments` → `posts.comments`）；
   - 全部被跳过（如 `src/api/posts.ts`）→ `general`（不把 `api`/`routes` 这类分层名当业务模块）。

### 3.4 过滤规则（前缀匹配）

- `selection.modules` 为前缀集合；模块 `m` 命中条件：`m == prefix || m.startsWith(prefix + '.')`；
- 例：选 `posts` → 命中 `posts`、`posts.comments`；选 `posts.comments` → **不**命中 `posts`；`posts2` 不命中 `posts`；
- baseline / current / range 三种模式都生效（workflow 归一化后统一过滤）；
- 不传 `selection` = 全部模块。

### 3.5 模块清单接口

先看再选：生成前可扫描代码库得到模块树。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/projects/:id/modules` | 返回最近一次扫描结果（`modules/scannedFiles/truncated/scannedAt`），可能为空 |
| `POST` | `/api/v1/projects/:id/modules/scan` | 投递 `module.scan` job（202），body `{ ref? }`；路径推断，不调用 LLM；Worker 内 10 分钟缓存 |

- 扫描基于「空树快照 + 路径推断」，最多 2000 文件，`truncated` 表示可能不全；
- 权限：`PERMISSION.GENERATION_CREATE`；租户由会话派生。

### 3.6 前端入口

- 生成页「新建生成任务」「一键生成初始用例集」两个表单均包含**模块树多选**（antd Tree，父节点可选且自动命中子树）+「手动补充模块 key」输入；
- 不选 → 全部模块；
- 生成详情展示：模式、颗粒度、识别模块列表；`stats.incomplete` 时展示裁剪告警。

### 3.7 子路径部署

前端以 `BrowserRouter basename={import.meta.env.BASE_URL}` 挂载，配合 `vite build --base=/gait/` 可在子路径下使用；刷新或深链（如 `/gait/t/default/projects`）不会跳出前缀、不会被同级站的根路径路由抢走。

## 4. 后续项

- ~~跨进程部署（API 与 Worker 分离）时，`GET /projects/:id/modules` 目前依赖同进程内存读取~~
  **已解决（2026-11-23）**：Worker 扫描完成后把结果写入 `projects.settings_json` 的保留键 `moduleScan`，
  API 先读进程内缓存、读不到再回退查库，API/Worker 分机部署也可读取。
- 模块树平铺（全量快照 2000+ 文件）时可按目录顶层分批扫描，避免单次 diff 预算不足。
