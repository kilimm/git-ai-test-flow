// 本文件所有改动要求遵循 agent-rules 规范
import { and, asc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { ValidationIssue } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { generationFiles } from '../schema.js';
import type { GenerationFile } from '../schema.js';

export interface SaveGenerationFileInput {
  path: string;
  action: string;
  content: string;
  contentHash: string;
  scenarioCount: number;
  validationStatus: string;
  validationErrors?: ValidationIssue[];
}

export interface UpdateGenerationFileInput {
  content?: string;
  contentHash?: string;
  action?: string;
  scenarioCount?: number;
  validationStatus?: string;
  validationErrors?: ValidationIssue[];
}

export class GenerationFileRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  /** 重新生成时整体替换草稿；人工编辑通过 updateContent 单独处理。 */
  replaceForGeneration(generationId: string, files: SaveGenerationFileInput[]): GenerationFile[] {
    const now = nowMs();

    this.db
      .delete(generationFiles)
      .where(
        and(
          eq(generationFiles.tenantId, this.tenantId),
          eq(generationFiles.generationId, generationId),
        ),
      )
      .run();

    if (files.length === 0) {
      return [];
    }

    return this.db
      .insert(generationFiles)
      .values(
        files.map((file) => ({
          id: uuidv7(now),
          tenantId: this.tenantId,
          generationId,
          path: file.path,
          action: file.action,
          content: file.content,
          contentHash: file.contentHash,
          scenarioCount: file.scenarioCount,
          validationStatus: file.validationStatus,
          validationErrorsJson: JSON.stringify(file.validationErrors ?? []),
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning()
      .all();
  }

  listByGeneration(generationId: string): GenerationFile[] {
    return this.db
      .select()
      .from(generationFiles)
      .where(
        and(
          eq(generationFiles.tenantId, this.tenantId),
          eq(generationFiles.generationId, generationId),
        ),
      )
      .orderBy(asc(generationFiles.path))
      .all();
  }

  findById(id: string): GenerationFile | undefined {
    return this.db
      .select()
      .from(generationFiles)
      .where(and(eq(generationFiles.id, id), eq(generationFiles.tenantId, this.tenantId)))
      .get();
  }

  updateContent(
    id: string,
    input: UpdateGenerationFileInput,
    now: number = nowMs(),
  ): GenerationFile | undefined {
    const values: Partial<GenerationFile> = { updatedAt: now };

    if (input.content !== undefined) {
      values.content = input.content;
    }

    if (input.contentHash !== undefined) {
      values.contentHash = input.contentHash;
    }

    if (input.action !== undefined) {
      values.action = input.action;
    }

    if (input.scenarioCount !== undefined) {
      values.scenarioCount = input.scenarioCount;
    }

    if (input.validationStatus !== undefined) {
      values.validationStatus = input.validationStatus;
    }

    if (input.validationErrors !== undefined) {
      values.validationErrorsJson = JSON.stringify(input.validationErrors);
    }

    return this.db
      .update(generationFiles)
      .set(values)
      .where(and(eq(generationFiles.id, id), eq(generationFiles.tenantId, this.tenantId)))
      .returning()
      .get();
  }

  markAllCommitted(generationId: string, commitSha: string, now: number = nowMs()): number {
    const result = this.db
      .update(generationFiles)
      .set({ committedSha: commitSha, updatedAt: now })
      .where(
        and(
          eq(generationFiles.tenantId, this.tenantId),
          eq(generationFiles.generationId, generationId),
        ),
      )
      .run();

    return result.changes;
  }
}
