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
  async replaceForGeneration(
    generationId: string,
    files: SaveGenerationFileInput[],
  ): Promise<GenerationFile[]> {
    const now = nowMs();

    return this.db.transaction(async (tx) => {
      await tx
        .delete(generationFiles)
        .where(
          and(
            eq(generationFiles.tenantId, this.tenantId),
            eq(generationFiles.generationId, generationId),
          ),
        );

      if (files.length === 0) {
        return [];
      }

      return tx
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
        .returning();
    });
  }

  async listByGeneration(generationId: string): Promise<GenerationFile[]> {
    return this.db
      .select()
      .from(generationFiles)
      .where(
        and(
          eq(generationFiles.tenantId, this.tenantId),
          eq(generationFiles.generationId, generationId),
        ),
      )
      .orderBy(asc(generationFiles.path));
  }

  async findById(id: string): Promise<GenerationFile | undefined> {
    const [row] = await this.db
      .select()
      .from(generationFiles)
      .where(and(eq(generationFiles.id, id), eq(generationFiles.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async updateContent(
    id: string,
    input: UpdateGenerationFileInput,
    now: number = nowMs(),
  ): Promise<GenerationFile | undefined> {
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

    const [row] = await this.db
      .update(generationFiles)
      .set(values)
      .where(and(eq(generationFiles.id, id), eq(generationFiles.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async markAllCommitted(
    generationId: string,
    commitSha: string,
    now: number = nowMs(),
  ): Promise<number> {
    const result = await this.db
      .update(generationFiles)
      .set({ committedSha: commitSha, updatedAt: now })
      .where(
        and(
          eq(generationFiles.tenantId, this.tenantId),
          eq(generationFiles.generationId, generationId),
        ),
      );

    return result.rowCount ?? 0;
  }
}
