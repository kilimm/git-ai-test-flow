// 本文件所有改动要求遵循 agent-rules 规范
import { and, count, desc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { HealthStatus, LlmProvider, LlmPurpose } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
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

  async create(input: CreateLlmProfileInput): Promise<LlmProfile> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
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
      .returning();

    return requireRow(row);
  }

  async listByProject(projectId: string): Promise<LlmProfile[]> {
    return this.db
      .select()
      .from(llmProfiles)
      .where(and(eq(llmProfiles.tenantId, this.tenantId), eq(llmProfiles.projectId, projectId)))
      .orderBy(desc(llmProfiles.createdAt), desc(llmProfiles.id));
  }

  async findById(id: string): Promise<LlmProfile | undefined> {
    const [row] = await this.db
      .select()
      .from(llmProfiles)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findByName(projectId: string, name: string): Promise<LlmProfile | undefined> {
    const [row] = await this.db
      .select()
      .from(llmProfiles)
      .where(
        and(
          eq(llmProfiles.tenantId, this.tenantId),
          eq(llmProfiles.projectId, projectId),
          eq(llmProfiles.name, name),
        ),
      )
      .limit(1);

    return row;
  }

  async update(
    id: string,
    input: UpdateLlmProfileInput,
    now: number = nowMs(),
  ): Promise<LlmProfile | undefined> {
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

    const [row] = await this.db
      .update(llmProfiles)
      .set(values)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(llmProfiles)
      .where(and(eq(llmProfiles.id, id), eq(llmProfiles.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }

  async countByCredential(credentialId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(llmProfiles)
      .where(
        and(eq(llmProfiles.tenantId, this.tenantId), eq(llmProfiles.credentialId, credentialId)),
      );

    return row?.count ?? 0;
  }
}
