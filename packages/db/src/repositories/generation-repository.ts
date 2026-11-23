// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, inArray, like } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { ApprovalStatus, GenerationMode, GenerationStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { generations } from '../schema.js';
import type { Generation, NewGeneration } from '../schema.js';

export interface CreateGenerationInput {
  id?: string;
  projectId: string;
  baseSha?: string | null;
  headSha: string;
  branch?: string | null;
  mode: GenerationMode;
  trigger?: string;
  status?: GenerationStatus;
  idempotencyKey: string;
  statsJson?: string;
  model?: string | null;
  promptVersion?: string | null;
  createdByUserId?: string | null;
  now?: number;
}

export interface UpdateGenerationInput {
  baseSha?: string | null;
  headSha?: string;
  branch?: string | null;
  status?: GenerationStatus;
  approvalStatus?: ApprovalStatus;
  featurePointsJson?: string;
  statsJson?: string;
  model?: string | null;
  promptVersion?: string | null;
  workflowThreadId?: string | null;
  errorJson?: string | null;
  finishedAt?: number | null;
}

export class GenerationRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateGenerationInput): Promise<Generation> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(generations)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        baseSha: input.baseSha ?? null,
        headSha: input.headSha,
        branch: input.branch ?? null,
        mode: input.mode,
        trigger: input.trigger ?? 'manual',
        status: input.status ?? 'queued',
        idempotencyKey: input.idempotencyKey,
        statsJson: input.statsJson ?? '{}',
        model: input.model ?? null,
        promptVersion: input.promptVersion ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async findById(id: string): Promise<Generation | undefined> {
    const [row] = await this.db
      .select()
      .from(generations)
      .where(and(eq(generations.id, id), eq(generations.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  /**
   * 带状态过滤的幂等查询：只有处于给定状态集合的记录才会被视为“重复请求”。
   * 用于让 failed / rejected / no_op 等终态记录不阻塞用户重试。
   */
  async findByProjectAndIdempotencyKey(
    projectId: string,
    key: string,
    statuses?: readonly GenerationStatus[],
  ): Promise<Generation | undefined> {
    const conditions = [
      eq(generations.tenantId, this.tenantId),
      eq(generations.projectId, projectId),
      eq(generations.idempotencyKey, key),
    ];
    if (statuses !== undefined && statuses.length > 0) {
      conditions.push(inArray(generations.status, [...statuses]));
    }

    const [row] = await this.db
      .select()
      .from(generations)
      .where(and(...conditions))
      .limit(1);

    return row;
  }

  /**
   * 按前缀列出幂等键，用于为重试派生不冲突的代次后缀。
   * 只返回 key，不取整行，避免额外开销。
   */
  async listIdempotencyKeysByPrefix(projectId: string, prefix: string): Promise<string[]> {
    const rows = await this.db
      .select({ idempotencyKey: generations.idempotencyKey })
      .from(generations)
      .where(
        and(
          eq(generations.tenantId, this.tenantId),
          eq(generations.projectId, projectId),
          like(generations.idempotencyKey, `${prefix}%`),
        ),
      );

    return rows.map((row) => row.idempotencyKey);
  }

  async listByProject(projectId: string, limit = 20): Promise<Generation[]> {
    return this.db
      .select()
      .from(generations)
      .where(and(eq(generations.tenantId, this.tenantId), eq(generations.projectId, projectId)))
      .orderBy(desc(generations.createdAt), desc(generations.id))
      .limit(limit);
  }

  async update(
    id: string,
    input: UpdateGenerationInput,
    now: number = nowMs(),
  ): Promise<Generation | undefined> {
    const values: Partial<NewGeneration> = { updatedAt: now };

    if (input.baseSha !== undefined) {
      values.baseSha = input.baseSha;
    }

    if (input.headSha !== undefined) {
      values.headSha = input.headSha;
    }

    if (input.branch !== undefined) {
      values.branch = input.branch;
    }

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.approvalStatus !== undefined) {
      values.approvalStatus = input.approvalStatus;
    }

    if (input.featurePointsJson !== undefined) {
      values.featurePointsJson = input.featurePointsJson;
    }

    if (input.statsJson !== undefined) {
      values.statsJson = input.statsJson;
    }

    if (input.model !== undefined) {
      values.model = input.model;
    }

    if (input.promptVersion !== undefined) {
      values.promptVersion = input.promptVersion;
    }

    if (input.workflowThreadId !== undefined) {
      values.workflowThreadId = input.workflowThreadId;
    }

    if (input.errorJson !== undefined) {
      values.errorJson = input.errorJson;
    }

    if (input.finishedAt !== undefined) {
      values.finishedAt = input.finishedAt;
    }

    const [row] = await this.db
      .update(generations)
      .set(values)
      .where(and(eq(generations.id, id), eq(generations.tenantId, this.tenantId)))
      .returning();

    return row;
  }
}
