// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { RepairGuardStatus, RepairReviewStatus } from '@gait/shared';
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
  reviewStatus?: RepairReviewStatus;
  featurePath?: string | null;
  appliedCommit?: string | null;
  now?: number;
}

export interface UpdateRepairAttemptInput {
  guardStatus?: RepairGuardStatus;
  reviewStatus?: RepairReviewStatus;
  patchedContent?: string | null;
  patchDiff?: string | null;
  rationale?: string;
  guardFindings?: unknown[];
  appliedCommit?: string | null;
  verifiedAt?: number | null;
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
        reviewStatus: input.reviewStatus ?? 'pending',
        featurePath: input.featurePath ?? null,
        appliedCommit: input.appliedCommit ?? null,
        createdAt: now,
      })
      .returning()
      .get();
  }

  update(id: string, input: UpdateRepairAttemptInput): RepairAttempt | undefined {
    return this.db
      .update(repairAttempts)
      .set({
        ...(input.guardStatus === undefined ? {} : { guardStatus: input.guardStatus }),
        ...(input.reviewStatus === undefined ? {} : { reviewStatus: input.reviewStatus }),
        ...(input.patchedContent === undefined ? {} : { patchedContent: input.patchedContent }),
        ...(input.patchDiff === undefined ? {} : { patchDiff: input.patchDiff }),
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        ...(input.guardFindings === undefined
          ? {}
          : { guardFindingsJson: JSON.stringify(input.guardFindings) }),
        ...(input.appliedCommit === undefined ? {} : { appliedCommit: input.appliedCommit }),
        ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
      })
      .where(and(eq(repairAttempts.id, id), eq(repairAttempts.tenantId, this.tenantId)))
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
