// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type {
  ScriptCatalogItem,
  ScriptKind,
  ScriptLibraryEntry,
  ScriptParamSpec,
  ScriptStatus,
} from '@gait/shared';
import { SCRIPT_STATUS } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { scriptLibrary } from '../schema.js';
import type { ScriptLibraryRow } from '../schema.js';

export interface CreateScriptInput {
  id?: string;
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description?: string;
  params?: ScriptParamSpec[];
  examples?: string[];
  source?: string | null;
  status?: ScriptStatus;
  version?: number;
  createdBy?: string | null;
  now?: number;
}

export interface UpdateScriptInput {
  moduleKey?: string;
  name?: string;
  kind?: ScriptKind;
  pattern?: string;
  description?: string;
  params?: ScriptParamSpec[];
  examples?: string[];
  source?: string | null;
  status?: ScriptStatus;
  sourceHash?: string | null;
  bumpVersion?: boolean;
  now?: number;
}

export interface SearchScriptsInput {
  /** 关键词：匹配 name/pattern/description/moduleKey。 */
  query?: string;
  moduleKeys?: string[];
  kinds?: ScriptKind[];
  statuses?: ScriptStatus[];
  limit?: number;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(value);

    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toEntry(row: ScriptLibraryRow): ScriptLibraryEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    moduleKey: row.moduleKey,
    name: row.name,
    kind: row.kind,
    pattern: row.pattern,
    description: row.description,
    params: parseJson<ScriptParamSpec[]>(row.paramsJson, []),
    examples: parseJson<string[]>(row.examplesJson, []),
    source: row.source,
    sourceHash: row.sourceHash,
    status: row.status,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 脚本库仓库（tenant 级）。
 * 所有写操作都需要 tenantId；读操作天然按 tenant 隔离。
 */
export class ScriptLibraryRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateScriptInput): Promise<ScriptLibraryEntry> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(scriptLibrary)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        moduleKey: input.moduleKey,
        name: input.name,
        kind: input.kind,
        pattern: input.pattern,
        description: input.description ?? '',
        paramsJson: JSON.stringify(input.params ?? []),
        examplesJson: JSON.stringify(input.examples ?? []),
        source: input.source ?? null,
        status: input.status ?? SCRIPT_STATUS.ACTIVE,
        version: input.version ?? 1,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toEntry(requireRow(row, 'script insert'));
  }

  async update(id: string, input: UpdateScriptInput): Promise<ScriptLibraryEntry> {
    const now = input.now ?? nowMs();
    const patch: Partial<ScriptLibraryRow> = { updatedAt: now };

    if (input.moduleKey !== undefined) patch.moduleKey = input.moduleKey;
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.pattern !== undefined) patch.pattern = input.pattern;
    if (input.description !== undefined) patch.description = input.description;
    if (input.params !== undefined) patch.paramsJson = JSON.stringify(input.params);
    if (input.examples !== undefined) patch.examplesJson = JSON.stringify(input.examples);
    if (input.source !== undefined) patch.source = input.source;
    if (input.sourceHash !== undefined) patch.sourceHash = input.sourceHash;
    if (input.status !== undefined) patch.status = input.status;

    if (input.bumpVersion === true) {
      patch.version = sql`${scriptLibrary.version} + 1` as unknown as number;
    }

    const [row] = await this.db
      .update(scriptLibrary)
      .set(patch)
      .where(and(eq(scriptLibrary.id, id), eq(scriptLibrary.tenantId, this.tenantId)))
      .returning();

    return toEntry(requireRow(row, 'script update'));
  }

  async findById(id: string): Promise<ScriptLibraryEntry | null> {
    const [row] = await this.db
      .select()
      .from(scriptLibrary)
      .where(and(eq(scriptLibrary.id, id), eq(scriptLibrary.tenantId, this.tenantId)))
      .limit(1);

    return row === undefined ? null : toEntry(row);
  }

  async findByModuleAndName(moduleKey: string, name: string): Promise<ScriptLibraryEntry | null> {
    const [row] = await this.db
      .select()
      .from(scriptLibrary)
      .where(
        and(
          eq(scriptLibrary.tenantId, this.tenantId),
          eq(scriptLibrary.moduleKey, moduleKey),
          eq(scriptLibrary.name, name),
        ),
      )
      .limit(1);

    return row === undefined ? null : toEntry(row);
  }

  async listByStatus(status: ScriptStatus): Promise<ScriptLibraryEntry[]> {
    const rows = await this.db
      .select()
      .from(scriptLibrary)
      .where(and(eq(scriptLibrary.tenantId, this.tenantId), eq(scriptLibrary.status, status)))
      .orderBy(scriptLibrary.moduleKey, scriptLibrary.name);

    return rows.map(toEntry);
  }

  /** 还原到 workspace 用：所有 active 脚本。 */
  async listActive(): Promise<ScriptLibraryEntry[]> {
    return this.listByStatus(SCRIPT_STATUS.ACTIVE);
  }

  async listAll(): Promise<ScriptLibraryEntry[]> {
    const rows = await this.db
      .select()
      .from(scriptLibrary)
      .where(eq(scriptLibrary.tenantId, this.tenantId))
      .orderBy(scriptLibrary.moduleKey, scriptLibrary.name);

    return rows.map(toEntry);
  }

  /**
   * 生成阶段的脚本检索：按关键词/模块/类型筛选。
   * 关键词只做大小写不敏感的模糊匹配，足够在提示词前做确定性预筛。
   */
  async search(input: SearchScriptsInput): Promise<ScriptCatalogItem[]> {
    const conditions = [
      eq(scriptLibrary.tenantId, this.tenantId),
      eq(scriptLibrary.status, SCRIPT_STATUS.ACTIVE),
    ];

    if (input.moduleKeys !== undefined && input.moduleKeys.length > 0) {
      conditions.push(inArray(scriptLibrary.moduleKey, input.moduleKeys));
    }

    if (input.kinds !== undefined && input.kinds.length > 0) {
      conditions.push(inArray(scriptLibrary.kind, input.kinds));
    }

    const query = input.query?.trim();

    if (query !== undefined && query.length > 0) {
      const needle = `%${query.toLowerCase()}%`;
      const keyword = or(
        like(sql`lower(${scriptLibrary.name})`, needle),
        like(sql`lower(${scriptLibrary.pattern})`, needle),
        like(sql`lower(${scriptLibrary.description})`, needle),
        like(sql`lower(${scriptLibrary.moduleKey})`, needle),
      );

      if (keyword !== undefined) {
        conditions.push(keyword);
      }
    }

    const rows = await this.db
      .select()
      .from(scriptLibrary)
      .where(and(...conditions))
      .orderBy(scriptLibrary.moduleKey, scriptLibrary.name)
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));

    return rows.map((row) => ({
      moduleKey: row.moduleKey,
      name: row.name,
      kind: row.kind,
      pattern: row.pattern,
      description: row.description,
      examples: parseJson<string[]>(row.examplesJson, []),
    }));
  }

  /**
   * 是否存在与给定 pattern 冲突的其他脚本（含 draft）：
   * 同一租户内不应出现两条完全相同的句式，否则激活后匹配顺序不可预期。
   */
  async findPatternConflict(pattern: string, excludeId?: string): Promise<ScriptLibraryEntry | null> {
    const rows = await this.db
      .select()
      .from(scriptLibrary)
      .where(
        and(
          eq(scriptLibrary.tenantId, this.tenantId),
          eq(scriptLibrary.pattern, pattern),
          inArray(scriptLibrary.status, [SCRIPT_STATUS.ACTIVE, SCRIPT_STATUS.DRAFT]),
        ),
      )
      .limit(5);

    const conflict = rows.find((row) => row.id !== excludeId);

    return conflict === undefined ? null : toEntry(conflict);
  }
}

/** 内置 step 的默认脚本库种子（首次还原时写入）。 */
export interface ScriptSeed {
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params?: ScriptParamSpec[];
  examples?: string[];
}

export const SCRIPT_SOURCE_KINDS: readonly ScriptKind[] = ['script', 'template'];
export const SCRIPT_KIND = {
  BUILTIN: 'builtin',
  TEMPLATE: 'template',
  SCRIPT: 'script',
  API: 'api',
  DB: 'db',
  UI: 'ui',
  AGENT: 'agent',
} as const satisfies Record<string, ScriptKind>;
