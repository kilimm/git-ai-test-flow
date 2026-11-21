// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, lte } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { TriggerAction, TriggerType } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
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

  create(input: CreateTriggerInput): TriggerConfig {
    const now = input.now ?? nowMs();

    return this.db
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
      .returning()
      .get();
  }

  listByProject(projectId: string): TriggerConfig[] {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(
        and(eq(triggerConfigs.tenantId, this.tenantId), eq(triggerConfigs.projectId, projectId)),
      )
      .all();
  }

  findById(id: string): TriggerConfig | undefined {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(and(eq(triggerConfigs.id, id), eq(triggerConfigs.tenantId, this.tenantId)))
      .get();
  }

  findByTokenHash(projectId: string, tokenHash: string): TriggerConfig | undefined {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(
        and(
          eq(triggerConfigs.tenantId, this.tenantId),
          eq(triggerConfigs.projectId, projectId),
          eq(triggerConfigs.tokenHash, tokenHash),
        ),
      )
      .get();
  }

  update(id: string, input: UpdateTriggerInput, now = nowMs()): TriggerConfig | undefined {
    return this.db
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
      .returning()
      .get();
  }

  remove(id: string): boolean {
    return (
      this.db
        .delete(triggerConfigs)
        .where(and(eq(triggerConfigs.id, id), eq(triggerConfigs.tenantId, this.tenantId)))
        .run().changes > 0
    );
  }

  /** Worker 调度器全局查询（跨租户但只返回调度所需字段）。 */
  listDue(now: number, limit = 20): TriggerConfig[] {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(
        and(
          eq(triggerConfigs.enabled, true),
          eq(triggerConfigs.type, 'schedule'),
          lte(triggerConfigs.nextRunAt, now),
        ),
      )
      .limit(limit)
      .all();
  }
}
