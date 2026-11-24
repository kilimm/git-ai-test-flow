# P1 验收报告（0.2.0）

日期：2026-11-21
范围：开发计划 M9-S1 ~ M9-S8、规格 22.1 P1 退出标准。

## 1. 验收环境

- Node.js 22、pnpm 10、Windows 11；Vitest + Playwright。
- 视觉 Agent 通过测试替身验证；真实 Midscene 与视觉模型需安装 `@midscene/web` 并配置 `purpose=vision` 的 LLM Profile，未在本机调用真实供应商。
- 文档 Graph C 使用本地 Git 测试库；未连接真实产品仓库。
- Webhook/部署回调使用 HTTP 注入测试；未调用真实 GitHub/GitLab/飞书。
- Docker 环境未安装，容器只做配置与镜像文件检查。

## 2. 功能结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `[agent]` UI 步骤 aiAct/aiAssert 与失败证据 | 通过（适配器） | `scenario.test.ts` 注入视觉 Agent 通过；缺少 Midscene 返回 `VISION_UNAVAILABLE`，不降级 skipped；每步截图产物 |
| 2 | 自修复 patch、guard、审批、回滚 | 通过 | `repair-proposal.test.ts`；`repairs.test.ts` 批准提交 Suite + 回滚恢复；guard 新增预期值变更必须人工批准 |
| 3 | 自动安全修复 | 通过（单元/组件） | `RunExecutor.repairFailedCases` 应用 `allowed` 补丁并重跑，提交 Suite；Graph B 增加 `repair_failed` 阶段 |
| 4 | 历史基线与多环境 A/B | 已移除 | 单环境运行重构：Run 不再支持 `baselineEnvironmentId`，报告不再输出基线环境摘要；`runs.baseline_environment_id` 列由迁移 0001 删除 |
| 5 | SSE 事件流 | 通过 | `/runs/:id/events` 与 `/generations/:id/events`；Last-Event-ID、心跳、终态关闭；前端 EventSource + 轮询兜底 |
| 6 | 项目级 RBAC 与成员 | 通过 | restricted 模式、项目成员角色、非成员 404、项目资源统一访问检查；E2E 只读角色页面 |
| 7 | Graph C 文档生成/增量/压缩 | 通过 | `syncProjectDocs`、模块 manifest、T0 永久保留、T1/T2/T3 从 T0 生成、搜索（M11 起 `search_text` + ILIKE）、人工编辑冲突保护；API 与 Docs 页面 |
| 8 | Webhook / 定时 / 影响面选测 | 通过 | 部署回调与 Git Webhook token、幂等、审计；Cron 解析与 Worker 调度；`selection.type=impact` 从 base..head 推断模块 |
| 9 | Docker runner | 部分通过 | Worker 镜像基于 Playwright 官方镜像、非 root、可执行 UI；本机无 Docker，未启动容器 |
| 10 | Webhook 幂等 | 通过 | 相同 head + environment + selection 返回已有 Run/Generation；`projects-access-triggers.test.ts` |
| 11 | 文档 100 条滚动压缩 | 通过 | 2,050 条测试数据生成 T1/T2/T3，最近 100 条不进入 rollup |
| 12 | 安全修复自动、高风险人工 | 通过 | `guardStatus=allowed` 才自动应用；预期值变更转 `human_required`；P0 的 suggestion-only 路径保留 |

## 3. 指标

| 指标 | 目标 | 结果 |
|---|---:|---:|
| 生成可执行率 | ≥80% | 保持 M4 100% 基线 |
| 归因准确率 | ≥75% | 规则矩阵回归通过；真实样本需生产校准 |
| 误修复率 | ≤2% | 自动应用仅限 guard=allowed，且要求重跑通过后才提交 |
| 跨租户越权 | 100% 拦截 | 项目/运行/资源测试通过 |
| SSE 断线续传 | 可恢复 | Last-Event-ID 单测通过 |
| 文档压缩 | 100 条 T0 | 2,050 条用例通过 |
| 触发幂等 | 100% | 部署/Git Webhook 集成测试通过 |

## 4. 未执行/需外部环境

1. 安装 `@midscene/web` 并配置真实视觉模型，执行真实 `aiAct`/`aiAssert` 与截图对比。
2. Docker Compose/独立 runner 容器启动与资源限制演练。
3. 真实 GitHub/GitLab Webhook、真实外部部署回调。
4. 真实产品仓库 Graph C 增量同步与 Git 推送。
5. Playwright 视觉截图对比（当前记录单步截图与断言，不做像素 diff）。

## 5. 结论

M9 P1 功能代码、数据库迁移、API、GUI、测试与验收记录已完成。真实视觉模型、容器与外部 Git/CI 属于部署环境验收项，已明确列出，未伪造通过结果。
