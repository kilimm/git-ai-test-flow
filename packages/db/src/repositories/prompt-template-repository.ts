// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { promptTemplates } from '../schema.js';
import type { PromptTemplateRow } from '../schema.js';

/** 生成管线中可配置的提示词阶段。 */
export const PROMPT_STAGES = ['summarize', 'extract', 'design', 'critique'] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];

export function isPromptStage(value: string): value is PromptStage {
  return (PROMPT_STAGES as readonly string[]).includes(value);
}

export interface PromptTemplateEntry {
  id: string;
  tenantId: string;
  stage: PromptStage;
  /** 用户自定义内容；空字符串表示使用代码内置默认值。 */
  content: string;
  version: number;
  updatedBy: string | null;
  updatedAt: number;
}

function toEntry(row: PromptTemplateRow): PromptTemplateEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    stage: row.stage as PromptStage,
    content: row.content,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

/**
 * 提示词模板仓库（tenant 级）。
 *
 * 一个租户每个阶段最多一行；不存在时视为"使用默认值"，由上层回退到代码内置 prompt。
 */
export class PromptTemplateRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async list(): Promise<PromptTemplateEntry[]> {
    const rows = await this.db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.tenantId, this.tenantId));

    return rows.map(toEntry);
  }

  async findByStage(stage: PromptStage): Promise<PromptTemplateEntry | null> {
    const [row] = await this.db
      .select()
      .from(promptTemplates)
      .where(
        and(eq(promptTemplates.tenantId, this.tenantId), eq(promptTemplates.stage, stage)),
      )
      .limit(1);

    return row === undefined ? null : toEntry(row);
  }

  /**
   * 写入（upsert）某阶段模板。`content` 为空串等价于"恢复默认"，仍保留行以便记版本号。
   * 每次写入 version+1，便于把"生成任务用了哪版模板"记进 stats。
   */
  async upsert(
    stage: PromptStage,
    content: string,
    updatedBy: string | null,
    now: number = nowMs(),
  ): Promise<PromptTemplateEntry> {
    const [row] = await this.db
      .insert(promptTemplates)
      .values({
        id: uuidv7(now),
        tenantId: this.tenantId,
        stage,
        content,
        version: 1,
        updatedBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [promptTemplates.tenantId, promptTemplates.stage],
        set: {
          content,
          updatedBy,
          updatedAt: now,
          version: sql`${promptTemplates.version} + 1` as unknown as number,
        },
      })
      .returning();

    return toEntry(requireRow(row, 'prompt template upsert'));
  }
}
