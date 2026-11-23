// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import type { CiProvider } from '../schema.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
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

  async listByProject(projectId: string): Promise<CiIntegration[]> {
    return this.db
      .select()
      .from(ciIntegrations)
      .where(
        and(eq(ciIntegrations.tenantId, this.tenantId), eq(ciIntegrations.projectId, projectId)),
      );
  }

  async findById(id: string): Promise<CiIntegration | undefined> {
    const [row] = await this.db
      .select()
      .from(ciIntegrations)
      .where(and(eq(ciIntegrations.id, id), eq(ciIntegrations.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async upsert(input: UpsertCiIntegrationInput): Promise<CiIntegration> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
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
      .returning();

    return requireRow(row);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(ciIntegrations)
      .where(and(eq(ciIntegrations.id, id), eq(ciIntegrations.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }
}
