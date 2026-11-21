// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import type { CiProvider } from '../schema.js';
import { TenantScopedRepository } from '../repository.js';
import { ciIntegrations } from '../schema.js';
import type { CiIntegration } from '../schema.js';

export interface UpsertCiIntegrationInput {
  id?: string;
  projectId: string;
  name: string;
  provider: CiProvider;
  repository: string;
  apiBaseUrl?: string | null;
  tokenCredentialId?: string | null;
  enabled?: boolean;
  now?: number;
}

export class CiIntegrationRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  listByProject(projectId: string): CiIntegration[] {
    return this.db
      .select()
      .from(ciIntegrations)
      .where(
        and(eq(ciIntegrations.tenantId, this.tenantId), eq(ciIntegrations.projectId, projectId)),
      )
      .all();
  }

  findById(id: string): CiIntegration | undefined {
    return this.db
      .select()
      .from(ciIntegrations)
      .where(and(eq(ciIntegrations.id, id), eq(ciIntegrations.tenantId, this.tenantId)))
      .get();
  }

  upsert(input: UpsertCiIntegrationInput): CiIntegration {
    const now = input.now ?? nowMs();

    return this.db
      .insert(ciIntegrations)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        name: input.name,
        provider: input.provider,
        repository: input.repository,
        apiBaseUrl: input.apiBaseUrl ?? null,
        tokenCredentialId: input.tokenCredentialId ?? null,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [ciIntegrations.projectId, ciIntegrations.name],
        set: {
          provider: input.provider,
          repository: input.repository,
          apiBaseUrl: input.apiBaseUrl ?? null,
          tokenCredentialId: input.tokenCredentialId ?? null,
          enabled: input.enabled ?? true,
          updatedAt: now,
        },
      })
      .returning()
      .get() as CiIntegration;
  }

  remove(id: string): boolean {
    return (
      this.db
        .delete(ciIntegrations)
        .where(and(eq(ciIntegrations.id, id), eq(ciIntegrations.tenantId, this.tenantId)))
        .run().changes > 0
    );
  }
}
