// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, inArray } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { caseBlobs } from '../schema.js';
import type { CaseBlob } from '../schema.js';

export interface PutCaseBlobInput {
  projectId: string;
  path: string;
  content: string;
  contentHash: string;
  origin?: string;
  sourceCommit?: string | null;
  updatedBy?: string | null;
  now?: number;
}

export interface CaseBlobSummary {
  path: string;
  contentHash: string;
  origin: string;
  sourceCommit: string | null;
  sizeBytes: number;
  updatedAt: number;
}

/**
 * 数据库模式下的用例内容仓库（project 级）。
 * repo 模式不写该表；迁移与手动编辑会写入。
 */
export class CaseBlobRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async listByProject(projectId: string): Promise<CaseBlob[]> {
    return this.db
      .select()
      .from(caseBlobs)
      .where(and(eq(caseBlobs.tenantId, this.tenantId), eq(caseBlobs.projectId, projectId)))
      .orderBy(caseBlobs.path);
  }

  /** 列出摘要（不含 content），用于列表页与迁移预检。 */
  async listSummaries(projectId: string): Promise<CaseBlobSummary[]> {
    const rows = await this.listByProject(projectId);

    return rows.map((row) => ({
      path: row.path,
      contentHash: row.contentHash,
      origin: row.origin,
      sourceCommit: row.sourceCommit,
      sizeBytes: row.content.length,
      updatedAt: row.updatedAt,
    }));
  }

  async findByPath(projectId: string, path: string): Promise<CaseBlob | null> {
    const [row] = await this.db
      .select()
      .from(caseBlobs)
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          eq(caseBlobs.path, path),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  async findPaths(projectId: string, paths: readonly string[]): Promise<Map<string, CaseBlob>> {
    if (paths.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select()
      .from(caseBlobs)
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          inArray(caseBlobs.path, [...paths]),
        ),
      );

    return new Map(rows.map((row) => [row.path, row]));
  }

  /** 写入/覆盖单个文件（按 project+path 幂等）。 */
  async put(input: PutCaseBlobInput): Promise<CaseBlob> {
    const now = input.now ?? nowMs();
    const values = {
      tenantId: this.tenantId,
      projectId: input.projectId,
      path: input.path,
      content: input.content,
      contentHash: input.contentHash,
      origin: input.origin ?? 'manual',
      sourceCommit: input.sourceCommit ?? null,
      updatedBy: input.updatedBy ?? null,
      updatedAt: now,
    };

    const [row] = await this.db
      .insert(caseBlobs)
      .values({ id: uuidv7(now), createdAt: now, ...values })
      .onConflictDoUpdate({
        target: [caseBlobs.projectId, caseBlobs.path],
        set: values,
      })
      .returning();

    if (row === undefined) {
      throw new Error('case blob upsert returned no row');
    }

    return row;
  }

  async deleteByPath(projectId: string, path: string): Promise<boolean> {
    const result = await this.db
      .delete(caseBlobs)
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          eq(caseBlobs.path, path),
        ),
      );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 批量导入（repo→db 迁移用）：整体在一个事务里，要么全部写入，要么全部回滚。
   *
   * 为什么要事务：迁移中途失败（网络/约束冲突）会留下「一半新、一半旧」的
   * 用例库，运行时的行为将不可解释。这里保证原子性。
   */
  async importMany(
    projectId: string,
    entries: readonly {
      path: string;
      content: string;
      contentHash: string;
      origin?: string;
      sourceCommit?: string | null;
    }[],
    options: { updatedBy?: string | null; now?: number } = {},
  ): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }

    const now = options.now ?? nowMs();

    return await this.db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx
          .insert(caseBlobs)
          .values({
            id: uuidv7(now),
            tenantId: this.tenantId,
            projectId,
            path: entry.path,
            content: entry.content,
            contentHash: entry.contentHash,
            origin: entry.origin ?? 'manual',
            sourceCommit: entry.sourceCommit ?? null,
            updatedBy: options.updatedBy ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [caseBlobs.projectId, caseBlobs.path],
            set: {
              content: entry.content,
              contentHash: entry.contentHash,
              origin: entry.origin ?? 'manual',
              sourceCommit: entry.sourceCommit ?? null,
              updatedBy: options.updatedBy ?? null,
              updatedAt: now,
            },
          });
      }

      return entries.length;
    });
  }

  async deleteAll(projectId: string): Promise<number> {    const result = await this.db
      .delete(caseBlobs)
      .where(and(eq(caseBlobs.tenantId, this.tenantId), eq(caseBlobs.projectId, projectId)));

    return result.rowCount ?? 0;
  }
}
