// 本文件所有改动要求遵循 agent-rules 规范
// JSONPath 工具已下沉到 @gait/shared，供 Server 与 Runner 共用；此处保留兼容导出。
export { jsonPathIssues, parseJsonPath, readJsonPath, readVersionString } from '@gait/shared';
export type { JsonPathParseResult, JsonPathToken } from '@gait/shared';
