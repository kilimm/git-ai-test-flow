// 本文件所有改动要求遵循 agent-rules 规范

/**
 * 脚本库（tenant 级）：Gherkin step 的唯一定义来源。
 *
 * 设计要点：
 * - 以 tenant 为作用域共享，避免每个项目重复维护 UI/DB 等通用 step；
 * - moduleKey 与 feature 的 @module 标签同构（点号分隔、全小写），便于按模块检索；
 * - description/examples 面向 LLM，用于「查找并复用」而非自由发明句式；
 * - source 存放可执行脚本（script/template/plugin），api/db/ui/builtin 不执行脚本。
 */

export const SCRIPT_KINDS = ['builtin', 'template', 'script', 'api', 'db', 'ui', 'agent'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

export const SCRIPT_STATUSES = ['draft', 'active', 'deprecated'] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

export const SCRIPT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
} as const satisfies Record<string, ScriptStatus>;

/** 需要可执行脚本体的 kind；api/db/ui/builtin 由 runner 内置执行器处理。 */
export const SCRIPT_KINDS_WITH_SOURCE: readonly ScriptKind[] = ['script', 'template'];

/** 参数描述，用于生成提示词中的调用说明与校验。 */
export interface ScriptParamSpec {
  /** 占位符名，如 string / int / method，与 pattern 中的 {name} 对应。 */
  name: string;
  type: 'string' | 'int' | 'word' | 'method' | 'jsonPath' | 'anything';
  required?: boolean | undefined;
  description: string;
  example?: string | undefined;
}

export interface ScriptLibraryEntry {
  id: string;
  tenantId: string;
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params: ScriptParamSpec[];
  examples: string[];
  source: string | null;
  sourceHash: string | null;
  status: ScriptStatus;
  version: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 检索结果：给生成阶段的精简视图，避免把整库塞进提示词。 */
export interface ScriptCatalogItem {
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  examples: string[];
}

export interface ScriptUsage {
  moduleKey: string;
  name: string;
  pattern: string;
}
