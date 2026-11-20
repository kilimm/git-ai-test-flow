// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { RepairGuardStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { repairAttempts } from '../schema.js';
import type { RepairAttempt } from '../schema.js';

export interface CreateRepairAttemptInput {
  id?: string;
  runCaseId: string;
  attemptNo: number;
  originalContent: string;
  patchedContent?: string | null;
  patchDiff?: string | null;
  repairClass: string;
  rationale: string;
  evidence?: unknown;
  model?: string | null;
  guardStatus: RepairGuardStatus;
  guardFindings?: unknown[];
  appliedCommit?: string | null;
  now?: number;
}

export class RepairAttemptRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateRepairAttemptInput): RepairAttempt {
    const now = input.now ?? nowMs();

    return this.db
      .insert(repairAttempts)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        runCaseId: input.runCaseId,
        attemptNo: input.attemptNo,
        originalContent: input.originalContent,
        patchedContent: input.patchedContent ?? null,
        patchDiff: input.patchDiff ?? null,
        repairClass: input.repairClass,
        rationale: input.rationale,
        evidenceJson: JSON.stringify(input.evidence ?? {}),
        model: input.model ?? null,
        guardStatus: input.guardStatus,
        guardFindingsJson: JSON.stringify(input.guardFindings ?? []),
        appliedCommit: input.appliedCommit ?? null,
        createdAt: now,
      })
      .returning()
      .get();
  }

  findById(id: string): RepairAttempt | undefined {
    return this.db
      .select()
      .from(repairAttempts)
      .where(and(eq(repairAttempts.id, id), eq(repairAttempts.tenantId, this.tenantId)))
      .get();
  }

  listByRunCase(runCaseId: string): RepairAttempt[] {
    return this.db
      .select()
      .from(repairAttempts)
      .where(
        and(eq(repairAttempts.tenantId, this.tenantId), eq(repairAttempts.runCaseId, runCaseId)),
      )
      .orderBy(repairAttempts.attemptNo)
      .all();
  }
}
