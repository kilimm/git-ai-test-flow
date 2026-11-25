// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, inArray, like } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { caseBlobs } from '../schema.js';
import type { CaseBlob } from '../schema.js';

export interface CaseContentEntry {
  path: string;
  content: string;
  origin: string;
  sourceCommit: string | null;
  updatedAt: number;
}

function toEntry(row: CaseBlob): CaseContentEntry {
  return {
    path: row.path,
    content: row.content,
    origin: row.origin,
    sourceCommit: row.sourceCommit,
    updatedAt: row.updatedAt,
  };
}

/**
 * 用例文件内容仓库：统一 repo / db 两种存储的读写接口。
 *
 * - db 模式下就是 `case_blobs` 表；
 * - repo 模式下用同一张表做「手动编辑暂存区」（origin=manual），执行前物化回 Suite。
 */
export class CaseContentRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async list(projectId: string): Promise<CaseContentEntry[]> {
    const rows = await this.db
      .select()
      .from(caseBlobs)
      .where(and(eq(caseBlobs.tenantId, this.tenantId), eq(caseBlobs.projectId, projectId)))
      .orderBy(caseBlobs.path);

    return rows.map(toEntry);
  }

  async listByPrefix(projectId: string, prefix: string): Promise<CaseContentEntry[]> {
    const rows = await this.db
      .select()
      .from(caseBlobs)
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          like(caseBlobs.path, `${prefix}%`),
        ),
      )
      .orderBy(caseBlobs.path);

    return rows.map(toEntry);
  }

  async findByPath(projectId: string, path: string): Promise<CaseContentEntry | null> {
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

    return row === undefined ? null : toEntry(row);
  }

  /** 写入/覆盖单个文件（含 contentHash 由调用方计算）。 */
  async put(input: {
    projectId: string;
    path: string;
    content: string;
    contentHash: string;
    origin: string;
    updatedBy?: string | null;
    now?: number;
  }): Promise<CaseContentEntry> {
    const now = input.now ?? nowMs();
    const values = {
      tenantId: this.tenantId,
      projectId: input.projectId,
      path: input.path,
      content: input.content,
      contentHash: input.contentHash,
      origin: input.origin,
      updatedBy: input.updatedBy ?? null,
      updatedAt: now,
    };

    const [row] = await this.db
      .insert(caseBlobs)
      .values({ id: uuidv7(now), sourceCommit: null, createdAt: now, ...values })
      .onConflictDoUpdate({
        target: [caseBlobs.projectId, caseBlobs.path],
        set: values,
      })
      .returning();

    if (row === undefined) {
      throw new Error('case content upsert returned no row');
    }

    return toEntry(row);
  }

  /** 原子改名：旧路径不存在则返回 null（避免覆盖他人新写的文件）。 */
  async rename(
    projectId: string,
    fromPath: string,
    toPath: string,
    options: { now?: number } = {},
  ): Promise<CaseContentEntry | null> {
    const now = options.now ?? nowMs();
    const existing = await this.findByPath(projectId, toPath);

    if (existing !== null) {
      throw new Error('target path already exists');
    }

    const [row] = await this.db
      .update(caseBlobs)
      .set({ path: toPath, updatedAt: now })
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          eq(caseBlobs.path, fromPath),
        ),
      )
      .returning();

    return row === undefined ? null : toEntry(row);
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

  async deleteByPaths(projectId: string, paths: readonly string[]): Promise<number> {
    if (paths.length === 0) {
      return 0;
    }

    const result = await this.db
      .delete(caseBlobs)
      .where(
        and(
          eq(caseBlobs.tenantId, this.tenantId),
          eq(caseBlobs.projectId, projectId),
          inArray(caseBlobs.path, [...paths]),
        ),
      );

    return result.rowCount ?? 0;
  }
}
