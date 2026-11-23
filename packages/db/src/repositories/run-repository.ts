// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, ne } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { RunStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { runs } from '../schema.js';
import type { NewRun, Run } from '../schema.js';

export interface CreateRunInput {
  id?: string;
  projectId: string;
  environmentId?: string | null;
  baselineEnvironmentId?: string | null;
  generationId?: string | null;
  trigger?: string;
  baseSha?: string | null;
  headSha: string;
  deployedSha?: string | null;
  versionMatch?: boolean | null;
  branch?: string | null;
  suites?: unknown[];
  selection?: unknown;
  status?: RunStatus;
  statsJson?: string;
  idempotencyKey: string;
  workflowThreadId?: string | null;
  errorJson?: string | null;
  createdByUserId?: string | null;
  now?: number;
}

export interface UpdateRunInput {
  status?: RunStatus;
  environmentId?: string | null;
  baselineEnvironmentId?: string | null;
  baseSha?: string | null;
  headSha?: string;
  deployedSha?: string | null;
  versionMatch?: boolean | null;
  branch?: string | null;
  statsJson?: string;
  selectionJson?: string;
  errorJson?: string | null;
  workflowThreadId?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export class RunRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateRunInput): Promise<Run> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(runs)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        environmentId: input.environmentId ?? null,
        baselineEnvironmentId: input.baselineEnvironmentId ?? null,
        generationId: input.generationId ?? null,
        trigger: input.trigger ?? 'manual',
        baseSha: input.baseSha ?? null,
        headSha: input.headSha,
        deployedSha: input.deployedSha ?? null,
        versionMatch: input.versionMatch ?? null,
        branch: input.branch ?? null,
        suitesJson: JSON.stringify(input.suites ?? ['suite']),
        selectionJson: JSON.stringify(input.selection ?? {}),
        status: input.status ?? 'queued',
        statsJson: input.statsJson ?? '{}',
        idempotencyKey: input.idempotencyKey,
        workflowThreadId: input.workflowThreadId ?? null,
        errorJson: input.errorJson ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async findById(id: string): Promise<Run | undefined> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, id), eq(runs.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findByProjectAndIdempotencyKey(projectId: string, key: string): Promise<Run | undefined> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, this.tenantId),
          eq(runs.projectId, projectId),
          eq(runs.idempotencyKey, key),
        ),
      )
      .limit(1);

    return row;
  }

  async listByProject(projectId: string, limit = 50): Promise<Run[]> {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), eq(runs.projectId, projectId)))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit);
  }

  /** 仅更新未进入终态的运行，防止 Prepare/Running 覆盖用户取消。 */
  async updateActive(
    id: string,
    input: UpdateRunInput,
    now: number = nowMs(),
  ): Promise<Run | undefined> {
    const values: Partial<NewRun> = { updatedAt: now };

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.startedAt !== undefined) {
      values.startedAt = input.startedAt;
    }

    if (input.workflowThreadId !== undefined) {
      values.workflowThreadId = input.workflowThreadId;
    }

    if (input.statsJson !== undefined) {
      values.statsJson = input.statsJson;
    }

    if (input.deployedSha !== undefined) {
      values.deployedSha = input.deployedSha;
    }

    if (input.versionMatch !== undefined) {
      values.versionMatch = input.versionMatch;
    }

    const [row] = await this.db
      .update(runs)
      .set(values)
      .where(
        and(
          eq(runs.id, id),
          eq(runs.tenantId, this.tenantId),
          ne(runs.status, 'canceled'),
          ne(runs.status, 'succeeded'),
          ne(runs.status, 'failed'),
        ),
      )
      .returning();

    return row;
  }

  async update(id: string, input: UpdateRunInput, now: number = nowMs()): Promise<Run | undefined> {
    const values: Partial<NewRun> = { updatedAt: now };

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.environmentId !== undefined) {
      values.environmentId = input.environmentId;
    }

    if (input.baselineEnvironmentId !== undefined) {
      values.baselineEnvironmentId = input.baselineEnvironmentId;
    }

    if (input.baseSha !== undefined) {
      values.baseSha = input.baseSha;
    }

    if (input.headSha !== undefined) {
      values.headSha = input.headSha;
    }

    if (input.deployedSha !== undefined) {
      values.deployedSha = input.deployedSha;
    }

    if (input.versionMatch !== undefined) {
      values.versionMatch = input.versionMatch;
    }

    if (input.branch !== undefined) {
      values.branch = input.branch;
    }

    if (input.statsJson !== undefined) {
      values.statsJson = input.statsJson;
    }

    if (input.selectionJson !== undefined) {
      values.selectionJson = input.selectionJson;
    }

    if (input.errorJson !== undefined) {
      values.errorJson = input.errorJson;
    }

    if (input.workflowThreadId !== undefined) {
      values.workflowThreadId = input.workflowThreadId;
    }

    if (input.startedAt !== undefined) {
      values.startedAt = input.startedAt;
    }

    if (input.finishedAt !== undefined) {
      values.finishedAt = input.finishedAt;
    }

    const [row] = await this.db
      .update(runs)
      .set(values)
      .where(and(eq(runs.id, id), eq(runs.tenantId, this.tenantId)))
      .returning();

    return row;
  }
}
