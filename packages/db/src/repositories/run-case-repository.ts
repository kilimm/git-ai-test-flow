// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, ne } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { Classification, RunCaseStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { runCases, runs } from '../schema.js';
import type { NewRunCase, RunCase } from '../schema.js';

export interface CreateRunCaseInput {
  id?: string;
  runId: string;
  caseId?: string | null;
  source?: string;
  featurePath: string;
  scenarioName: string;
  line?: number;
  caseKey?: string | null;
  tags?: string[];
  layer?: string | null;
  status?: RunCaseStatus;
}

export interface UpdateRunCaseInput {
  status?: RunCaseStatus;
  attempt?: number;
  classification?: Classification | null;
  confidence?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  evidenceJson?: string;
  repairStatus?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface RunCaseHistoryEntry {
  runId: string;
  headSha: string;
  runStatus: string;
  caseStatus: string;
  classification: Classification | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export class RunCaseRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async createMany(
    inputs: readonly CreateRunCaseInput[],
    now: number = nowMs(),
  ): Promise<RunCase[]> {
    if (inputs.length === 0) {
      return [];
    }

    const rows: NewRunCase[] = inputs.map((input) => ({
      id: input.id ?? uuidv7(now),
      tenantId: this.tenantId,
      runId: input.runId,
      caseId: input.caseId ?? null,
      source: input.source ?? 'suite',
      featurePath: input.featurePath,
      scenarioName: input.scenarioName,
      line: input.line ?? 1,
      caseKey: input.caseKey ?? null,
      tagsJson: JSON.stringify(input.tags ?? []),
      layer: input.layer ?? null,
      status: input.status ?? 'pending',
    }));

    return this.db.insert(runCases).values(rows).returning();
  }

  async listByRun(runId: string): Promise<RunCase[]> {
    return this.db
      .select()
      .from(runCases)
      .where(and(eq(runCases.tenantId, this.tenantId), eq(runCases.runId, runId)))
      .orderBy(runCases.featurePath, runCases.startedAt, runCases.id);
  }

  async findById(id: string): Promise<RunCase | undefined> {
    const [row] = await this.db
      .select()
      .from(runCases)
      .where(and(eq(runCases.id, id), eq(runCases.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  /**
   * 查询同一项目、同一场景的历史结果（不含当前 Run），
   * 用于判断「历史通过 + 当前失败」等基线信号。
   */
  async listHistory(input: {
    projectId: string;
    featurePath: string;
    scenarioName: string;
    caseKey: string | null;
    excludeRunId: string;
    environmentId?: string | null;
    limit?: number;
  }): Promise<RunCaseHistoryEntry[]> {
    const conditions = [
      eq(runCases.tenantId, this.tenantId),
      eq(runs.projectId, input.projectId),
      ne(runCases.runId, input.excludeRunId),
      eq(runCases.featurePath, input.featurePath),
      eq(runCases.scenarioName, input.scenarioName),
      ...(input.caseKey === null ? [] : [eq(runCases.caseKey, input.caseKey)]),
      ...(input.environmentId === undefined || input.environmentId === null
        ? []
        : [eq(runs.environmentId, input.environmentId)]),
    ];

    const rows = await this.db
      .select({
        runId: runCases.runId,
        headSha: runs.headSha,
        runStatus: runs.status,
        caseStatus: runCases.status,
        classification: runCases.classification,
        startedAt: runCases.startedAt,
        finishedAt: runCases.finishedAt,
      })
      .from(runCases)
      .innerJoin(runs, eq(runCases.runId, runs.id))
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(Math.min(50, Math.max(1, input.limit ?? 10)));

    return rows as RunCaseHistoryEntry[];
  }

  async update(id: string, input: UpdateRunCaseInput): Promise<RunCase | undefined> {
    const values: Partial<NewRunCase> = {};

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.attempt !== undefined) {
      values.attempt = input.attempt;
    }

    if (input.classification !== undefined) {
      values.classification = input.classification;
    }

    if (input.confidence !== undefined) {
      values.confidence = input.confidence;
    }

    if (input.durationMs !== undefined) {
      values.durationMs = input.durationMs;
    }

    if (input.errorMessage !== undefined) {
      values.errorMessage = input.errorMessage;
    }

    if (input.evidenceJson !== undefined) {
      values.evidenceJson = input.evidenceJson;
    }

    if (input.repairStatus !== undefined) {
      values.repairStatus = input.repairStatus;
    }

    if (input.startedAt !== undefined) {
      values.startedAt = input.startedAt;
    }

    if (input.finishedAt !== undefined) {
      values.finishedAt = input.finishedAt;
    }

    const [row] = await this.db
      .update(runCases)
      .set(values)
      .where(and(eq(runCases.id, id), eq(runCases.tenantId, this.tenantId)))
      .returning();

    return row;
  }
}
