// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { ArtifactType } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { artifacts } from '../schema.js';
import type { Artifact } from '../schema.js';

export interface CreateArtifactInput {
  id?: string;
  runId: string;
  runCaseId?: string | null;
  stepResultId?: string | null;
  type: ArtifactType;
  storage?: string;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  redacted?: boolean;
  expiresAt?: number | null;
  metadata?: unknown;
}

export class ArtifactRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateArtifactInput, now: number = nowMs()): Artifact {
    return this.db
      .insert(artifacts)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        runId: input.runId,
        runCaseId: input.runCaseId ?? null,
        stepResultId: input.stepResultId ?? null,
        type: input.type,
        storage: input.storage ?? 'local',
        path: input.path,
        mime: input.mime,
        size: input.size,
        sha256: input.sha256,
        redacted: input.redacted ?? false,
        expiresAt: input.expiresAt ?? null,
        metadataJson: JSON.stringify(input.metadata ?? {}),
        createdAt: now,
      })
      .returning()
      .get();
  }

  listByRun(runId: string): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, this.tenantId), eq(artifacts.runId, runId)))
      .orderBy(artifacts.createdAt)
      .all();
  }

  listByRunCase(runCaseId: string): Artifact[] {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.tenantId, this.tenantId), eq(artifacts.runCaseId, runCaseId)))
      .orderBy(artifacts.createdAt)
      .all();
  }

  findById(id: string): Artifact | undefined {
    return this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.tenantId, this.tenantId)))
      .get();
  }
}
