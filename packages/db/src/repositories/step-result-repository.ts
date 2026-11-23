// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { StepStatus, StepExecutionType } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { stepResults } from '../schema.js';
import type { NewStepResult, StepResult } from '../schema.js';

export interface CreateStepResultInput {
  id?: string;
  runCaseId: string;
  stepIndex: number;
  keyword: string;
  text: string;
  type: StepExecutionType | 'unknown';
  status?: StepStatus;
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  artifacts?: unknown[];
  agentMeta?: unknown;
}

export interface UpdateStepResultInput {
  status?: StepStatus;
  durationMs?: number | null;
  outputJson?: string;
  errorJson?: string | null;
  artifactsJson?: string;
  agentMetaJson?: string | null;
}

export class StepResultRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateStepResultInput, now: number = nowMs()): Promise<StepResult> {
    const [row] = await this.db
      .insert(stepResults)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        runCaseId: input.runCaseId,
        stepIndex: input.stepIndex,
        keyword: input.keyword,
        text: input.text,
        type: input.type,
        status: input.status ?? 'pending',
        durationMs: input.durationMs ?? null,
        inputJson: JSON.stringify(input.input ?? {}),
        outputJson: JSON.stringify(input.output ?? {}),
        errorJson: input.error === undefined ? null : JSON.stringify(input.error),
        artifactsJson: JSON.stringify(input.artifacts ?? []),
        agentMetaJson: input.agentMeta === undefined ? null : JSON.stringify(input.agentMeta),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async update(
    id: string,
    input: UpdateStepResultInput,
    now: number = nowMs(),
  ): Promise<StepResult | undefined> {
    const values: Partial<NewStepResult> = { updatedAt: now };

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.durationMs !== undefined) {
      values.durationMs = input.durationMs;
    }

    if (input.outputJson !== undefined) {
      values.outputJson = input.outputJson;
    }

    if (input.errorJson !== undefined) {
      values.errorJson = input.errorJson;
    }

    if (input.artifactsJson !== undefined) {
      values.artifactsJson = input.artifactsJson;
    }

    if (input.agentMetaJson !== undefined) {
      values.agentMetaJson = input.agentMetaJson;
    }

    const [row] = await this.db
      .update(stepResults)
      .set(values)
      .where(and(eq(stepResults.id, id), eq(stepResults.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async listByRunCase(runCaseId: string): Promise<StepResult[]> {
    return this.db
      .select()
      .from(stepResults)
      .where(and(eq(stepResults.tenantId, this.tenantId), eq(stepResults.runCaseId, runCaseId)))
      .orderBy(stepResults.stepIndex);
  }

  /** 重跑前清理上一次尝试的步骤，避免同一场景出现重复 step index。 */
  async deleteByRunCase(runCaseId: string): Promise<number> {
    const result = await this.db
      .delete(stepResults)
      .where(and(eq(stepResults.tenantId, this.tenantId), eq(stepResults.runCaseId, runCaseId)));

    return result.rowCount ?? 0;
  }
}
