// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { Classification, RunCaseStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { runCases } from '../schema.js';
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

export class RunCaseRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  createMany(inputs: readonly CreateRunCaseInput[], now: number = nowMs()): RunCase[] {
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

    return this.db.insert(runCases).values(rows).returning().all();
  }

  listByRun(runId: string): RunCase[] {
    return this.db
      .select()
      .from(runCases)
      .where(and(eq(runCases.tenantId, this.tenantId), eq(runCases.runId, runId)))
      .orderBy(runCases.featurePath, runCases.startedAt, runCases.id)
      .all();
  }

  findById(id: string): RunCase | undefined {
    return this.db
      .select()
      .from(runCases)
      .where(and(eq(runCases.id, id), eq(runCases.tenantId, this.tenantId)))
      .get();
  }

  update(id: string, input: UpdateRunCaseInput): RunCase | undefined {
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

    return this.db
      .update(runCases)
      .set(values)
      .where(and(eq(runCases.id, id), eq(runCases.tenantId, this.tenantId)))
      .returning()
      .get();
  }
}
