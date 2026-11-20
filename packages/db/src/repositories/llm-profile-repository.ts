// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { HealthStatus, LlmProvider, LlmPurpose } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { llmProfiles } from '../schema.js';
import type { LlmProfile, NewLlmProfile } from '../schema.js';

export interface CreateLlmProfileInput {
  id?: string;
  projectId: string;
  name: string;
  purpose: LlmPurpose;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  credentialId?: string | null;
  paramsJson?: string;
  enabled?: boolean;
  now?: number;
}

export interface UpdateLlmProfileInput {
  name?: string;
  purpose?: LlmPurpose;
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  credentialId?: string | null;
  paramsJson?: string;
  enabled?: boolean;
  healthStatus?: HealthStatus;
  healthCheckedAt?: number | null;
  healthMessage?: string | null;
}

export class LlmProfileRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateLlmProfileInput): LlmProfile {
    const now = input.now ?? nowMs();

    return this.db
      .insert(llmProfiles)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        name: input.name,
        purpose: input.purpose,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        credentialId: input.credentialId ?? null,
        paramsJson: input.paramsJson ?? '{}',
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  listByProject(projectId: string): LlmProfile[] {
    return this.db
      .select()
      .from(llmProfiles)
      .where(and(eq(llmProfiles.tenantId, this.tenantId), eq(llmProfiles.projectId, projectId)))
      .orderBy(desc(llmProfiles.createdAt), desc(llmProfiles.id))
      .all();
  }

  findById(id: string): LlmProfile | undefined {
    return this.db
      .select()
      .from(llmProfiles)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)))
      .get();
  }

  findByName(projectId: string, name: string): LlmProfile | undefined {
    return this.db
      .select()
      .from(llmProfiles)
      .where(
        and(
          eq(llmProfiles.tenantId, this.tenantId),
          eq(llmProfiles.projectId, projectId),
          eq(llmProfiles.name, name),
        ),
      )
      .get();
  }

  update(id: string, input: UpdateLlmProfileInput, now: number = nowMs()): LlmProfile | undefined {
    const values: Partial<NewLlmProfile> = { updatedAt: now };

    if (input.name !== undefined) {
      values.name = input.name;
    }

    if (input.purpose !== undefined) {
      values.purpose = input.purpose;
    }

    if (input.provider !== undefined) {
      values.provider = input.provider;
    }

    if (input.baseUrl !== undefined) {
      values.baseUrl = input.baseUrl;
    }

    if (input.model !== undefined) {
      values.model = input.model;
    }

    if (input.credentialId !== undefined) {
      values.credentialId = input.credentialId;
    }

    if (input.paramsJson !== undefined) {
      values.paramsJson = input.paramsJson;
    }

    if (input.enabled !== undefined) {
      values.enabled = input.enabled;
    }

    if (input.healthStatus !== undefined) {
      values.healthStatus = input.healthStatus;
    }

    if (input.healthCheckedAt !== undefined) {
      values.healthCheckedAt = input.healthCheckedAt;
    }

    if (input.healthMessage !== undefined) {
      values.healthMessage = input.healthMessage;
    }

    return this.db
      .update(llmProfiles)
      .set(values)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)))
      .returning()
      .get();
  }

  remove(id: string): boolean {
    const result = this.db
      .delete(llmProfiles)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)))
      .run();

    return result.changes > 0;
  }

  countByCredential(credentialId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(llmProfiles)
      .where(
        and(eq(llmProfiles.tenantId, this.tenantId), eq(llmProfiles.credentialId, credentialId)),
      )
      .get();

    return row?.count ?? 0;
  }
}
