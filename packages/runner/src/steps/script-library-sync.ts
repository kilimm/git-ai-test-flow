// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import type { ScriptLibraryEntry, ScriptParamSpec } from '@gait/shared';
import { SCRIPT_STATUS } from '@gait/shared';
import type { ScriptLibraryRepository } from '@gait/db';
import type { SuiteRepository } from '@gait/git';
import type { StepDefinitionInput } from './registry.js';

/** steps/registry.json 中的一条定义（与 StepRegistry 的输入结构一致）。 */
export interface RegistryStepEntry {
  name: string;
  type: string;
  pattern: string;
  script?: string;
  template?: string;
  module?: string;
  description?: string;
  examples?: string[];
}

export interface RegistryDocument {
  version: 1;
  modules: Record<string, { description: string; steps: string[] }>;
  steps: RegistryStepEntry[];
}

/** 脚本文件在 suite 中的路径：steps/modules/<module>/<name>.mjs。 */
export function scriptPathOf(entry: { moduleKey: string; name: string }): string {
  return `steps/modules/${entry.moduleKey}/${entry.name}.mjs`;
}

export function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 16);
}

function needsSourceFile(type: string): boolean {
  return type === 'script' || type === 'template' || type === 'plugin';
}

/**
 * 把脚本库渲染成 suite 内的 steps/registry.json。
 *
 * registry.json 是**派生产物**：DB 是事实源，每次 workspace 准备时重建，
 * 人工修改会被覆盖。需要新增脚本请走脚本库 API/生成提案流程。
 */
export function renderRegistry(entries: readonly ScriptLibraryEntry[]): RegistryDocument {
  const modules: Record<string, { description: string; steps: string[] }> = {};
  const steps: RegistryStepEntry[] = [];

  for (const entry of entries) {
    const moduleEntry = (modules[entry.moduleKey] ??= {
      description: `module ${entry.moduleKey}`,
      steps: [],
    });

    moduleEntry.steps.push(entry.name);

    const item: RegistryStepEntry = {
      name: entry.name,
      type: entry.kind,
      pattern: entry.pattern,
      module: entry.moduleKey,
      description: entry.description,
    };

    if (entry.examples.length > 0) {
      item.examples = entry.examples;
    }

    if (needsSourceFile(entry.kind)) {
      item.script = scriptPathOf(entry);
    }

    steps.push(item);
  }

  return { version: 1, modules, steps };
}

export interface ScriptLibraryRestoreResult {
  written: string[];
  skipped: string[];
}

/**
 * 把租户脚本库还原到 suite worktree（DB → workspace）。
 *
 * - active 条目全部还原；draft/deprecated 不落到 workspace（避免被误用）；
 * - 只有内容变化的文件才写入，保证幂等且减少 IO；
 * - 只写 steps/ 下的文件，不提交 Git（由用户决定的提交动作单独执行）。
 */
export function restoreScriptLibrary(input: {
  suite: SuiteRepository;
  entries: readonly ScriptLibraryEntry[];
}): ScriptLibraryRestoreResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const active = input.entries.filter((entry) => entry.status === SCRIPT_STATUS.ACTIVE);

  for (const entry of active) {
    if (needsSourceFile(entry.kind)) {
      if (entry.source === null || entry.source.trim().length === 0) {
        skipped.push(`${entry.moduleKey}/${entry.name}: missing source`);
        continue;
      }

      const path = scriptPathOf(entry);

      if (input.suite.readFile(path) !== entry.source) {
        input.suite.stageStepFile(path, entry.source);
        written.push(path);
      }
    }
  }

  const registry = renderRegistry(active);
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;

  if (input.suite.readFile('steps/registry.json') !== serialized) {
    input.suite.stageStepFile('steps/registry.json', serialized);
    written.push('steps/registry.json');
  }

  return { written, skipped };
}

/** 由 pattern 推导参数名列表（{string} 等占位符）。 */
export function paramsOfPattern(pattern: string): ScriptParamSpec[] {
  const matches = pattern.matchAll(/\{([A-Za-z]+)\}/g);
  const seen = new Set<string>();
  const specs: ScriptParamSpec[] = [];

  for (const match of matches) {
    const name = match[1] ?? '';

    if (name.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    specs.push({ name, type: name as ScriptParamSpec['type'], description: `${name} 参数` });
  }

  return specs;
}

/** 把脚本库条目转成 StepRegistry 的定义输入。 */
export function toStepDefinitions(
  entries: readonly ScriptLibraryEntry[],
): StepDefinitionInput[] {
  return entries
    .filter((entry) => entry.status === SCRIPT_STATUS.ACTIVE)
    .map((entry) => ({
      name: entry.name,
      type: entry.kind as StepDefinitionInput['type'],
      pattern: entry.pattern,
      ...(needsSourceFile(entry.kind) ? { script: scriptPathOf(entry) } : {}),
    }));
}

/** 生成阶段用的脚本目录文本（按模块分组，含调用示意），控制 token 用量。 */
export function formatScriptCatalog(
  entries: readonly ScriptLibraryEntry[],
  options: { maxSteps?: number } = {},
): string {
  const limit = options.maxSteps ?? 60;
  const grouped = new Map<string, ScriptLibraryEntry[]>();

  for (const entry of entries.slice(0, limit)) {
    const list = grouped.get(entry.moduleKey) ?? [];
    list.push(entry);
    grouped.set(entry.moduleKey, list);
  }

  const lines: string[] = [];

  for (const [moduleKey, list] of grouped) {
    lines.push(`### ${moduleKey}`);
    for (const entry of list) {
      lines.push(`- ${entry.pattern}  [${entry.kind}] ${entry.description}`.trimEnd());
      for (const example of entry.examples.slice(0, 2)) {
        lines.push(`  示例: ${example}`);
      }
    }
  }

  return lines.join('\n');
}

export type { ScriptLibraryRepository };
