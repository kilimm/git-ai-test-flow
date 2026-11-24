// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import type { ScriptKind, ScriptParamSpec, ScriptStatus } from '@gait/shared';
import { SCRIPT_STATUS } from '@gait/shared';
import type { ScriptLibraryRepository } from '@gait/db';
import { BUILTIN_STEP_SEEDS } from './builtin-seeds.js';

export interface ScriptLibrarySyncPlan {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function hashOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 内置 step 种子 → 租户脚本库。
 *
 * - 租户首次初始化或新增内置 step 时调用，幂等；
 * - **不覆盖**租户已改过的条目：只有当 DB 行的 pattern/description/kind
 *   与种子完全一致（说明用户没动过）且 version=1 时才跟随升级；
 * - 库里已有同名条目但内容不同 → 跳过并计入 skipped，交由人工/提案流程处理。
 */
export async function seedScriptLibrary(
  repository: ScriptLibraryRepository,
): Promise<ScriptLibrarySyncPlan> {
  const plan: ScriptLibrarySyncPlan = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const seed of BUILTIN_STEP_SEEDS) {
    const existing = await repository.findByModuleAndName(seed.moduleKey, seed.name);

    if (existing === null) {
      await repository.create({
        moduleKey: seed.moduleKey,
        name: seed.name,
        kind: seed.kind,
        pattern: seed.pattern,
        description: seed.description,
        params: (seed.params ?? []) as ScriptParamSpec[],
        examples: seed.examples ?? [],
        source: null,
        status: SCRIPT_STATUS.ACTIVE,
        version: 1,
        createdBy: null,
      });
      plan.created += 1;
      continue;
    }

    // 用户改过（version>1 或 pattern 不同）→ 不动。
    if (existing.version > 1 || existing.pattern !== seed.pattern) {
      plan.skipped += 1;
      continue;
    }

    if (
      existing.description === seed.description &&
      existing.kind === seed.kind &&
      JSON.stringify(existing.examples) === JSON.stringify(seed.examples ?? [])
    ) {
      plan.unchanged += 1;
      continue;
    }

    await repository.update(existing.id, {
      description: seed.description,
      params: (seed.params ?? []) as ScriptParamSpec[],
      examples: seed.examples ?? [],
    });
    plan.updated += 1;
  }

  return plan;
}

export interface ScriptDraftInput {
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params?: ScriptParamSpec[];
  examples?: string[];
  source?: string | null;
  createdBy?: string | null;
}

export interface ScriptDraftResult {
  ok: boolean;
  entryId: string | null;
  status: ScriptStatus | null;
  reason: string | null;
  conflictWith: string | null;
}

/**
 * 新增脚本草稿：必须能编译、pattern 不与同租户 active 条目冲突。
 * 校验通过后为 draft（不参与还原，避免未经运行验证的脚本污染用例）。
 */
export async function createScriptDraft(
  repository: ScriptLibraryRepository,
  input: ScriptDraftInput,
  compile: (pattern: string) => RegExp,
): Promise<ScriptDraftResult> {
  try {
    compile(input.pattern);
  } catch (error) {
    return {
      ok: false,
      entryId: null,
      status: null,
      reason: `pattern 无法编译: ${error instanceof Error ? error.message : String(error)}`,
      conflictWith: null,
    };
  }

  const conflict = await repository.findPatternConflict(input.pattern);

  if (conflict !== null) {
    return {
      ok: false,
      entryId: null,
      status: null,
      reason: 'pattern 与已有 active 脚本冲突',
      conflictWith: `${conflict.moduleKey}/${conflict.name}`,
    };
  }

  const existing = await repository.findByModuleAndName(input.moduleKey, input.name);

  if (existing !== null) {
    return {
      ok: false,
      entryId: existing.id,
      status: existing.status,
      reason: '同模块下已存在同名脚本',
      conflictWith: `${existing.moduleKey}/${existing.name}`,
    };
  }

  const entry = await repository.create({
    moduleKey: input.moduleKey,
    name: input.name,
    kind: input.kind,
    pattern: input.pattern,
    description: input.description,
    params: input.params ?? [],
    examples: input.examples ?? [],
    source: input.source ?? null,
    status: SCRIPT_STATUS.DRAFT,
    version: 1,
    createdBy: input.createdBy ?? null,
  });

  return { ok: true, entryId: entry.id, status: entry.status, reason: null, conflictWith: null };
}

/** 提升 draft → active：调用方必须已用真实用例验证通过。 */
export async function activateScript(
  repository: ScriptLibraryRepository,
  id: string,
): Promise<boolean> {
  const entry = await repository.findById(id);

  if (entry === null || entry.status !== SCRIPT_STATUS.DRAFT) {
    return false;
  }

  await repository.update(id, { status: SCRIPT_STATUS.ACTIVE, bumpVersion: true });

  return true;
}

export { hashOf };
