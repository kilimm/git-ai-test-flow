// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { TriggerAction, TriggerType } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { triggerConfigs } from '../schema.js';
import type { TriggerConfig } from '../schema.js';

export interface CreateTriggerInput {
  id?: string;
  projectId: string;
  name: string;
  type: TriggerType;
  action: TriggerAction;
  enabled?: boolean;
  cron?: string | null;
  branch?: string | null;
  environmentId?: string | null;
  selection?: unknown;
  tokenHash?: string | null;
  nextRunAt?: number | null;
  now?: number;
}

export interface UpdateTriggerInput {
  name?: string;
  enabled?: boolean;
  cron?: string | null;
  branch?: string | null;
  environmentId?: string | null;
  selection?: unknown;
  tokenHash?: string | null;
  nextRunAt?: number | null;
  lastFiredAt?: number | null;
}

export class TriggerRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateTriggerInput): Promise<TriggerConfig> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(triggerConfigs)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        name: input.name,
        type: input.type,
        action: input.action,
        enabled: input.enabled ?? true,
        cron: input.cron ?? null,
        branch: input.branch ?? null,
        environmentId: input.environmentId ?? null,
        selectionJson: JSON.stringify(
          input.selection ?? { type: 'all', modules: [], caseKeys: [] },
        ),
        tokenHash: input.tokenHash ?? null,
        nextRunAt: input.nextRunAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async listByProject(projectId: string): Promise<TriggerConfig[]> {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(
        and(eq(triggerConfigs.tenantId, this.tenantId), eq(triggerConfigs.projectId, projectId)),
      );
  }

  async findById(id: string): Promise<TriggerConfig | undefined> {
    const [row] = await this.db
      .select()
      .from(triggerConfigs)
      .where(and(eq(triggerConfigs.id, id), eq(triggerConfigs.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findByTokenHash(projectId: string, tokenHash: string): Promise<TriggerConfig | undefined> {
    const [row] = await this.db
      .select()
      .from(triggerConfigs)
      .where(
        and(
          eq(triggerConfigs.tenantId, this.tenantId),
          eq(triggerConfigs.projectId, projectId),
          eq(triggerConfigs.tokenHash, tokenHash),
        ),
      )
      .limit(1);

    return row;
  }

  async update(
    id: string,
    input: UpdateTriggerInput,
    now = nowMs(),
  ): Promise<TriggerConfig | undefined> {
    const [row] = await this.db
      .update(triggerConfigs)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.cron === undefined ? {} : { cron: input.cron }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
        ...(input.selection === undefined
          ? {}
          : { selectionJson: JSON.stringify(input.selection) }),
        ...(input.tokenHash === undefined ? {} : { tokenHash: input.tokenHash }),
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
        ...(input.lastFiredAt === undefined ? {} : { lastFiredAt: input.lastFiredAt }),
        updatedAt: now,
      })
      .where(and(eq(triggerConfigs.id, id), eq(triggerConfigs.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(triggerConfigs)
      .where(and(eq(triggerConfigs.id, id), eq(triggerConfigs.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }
}
