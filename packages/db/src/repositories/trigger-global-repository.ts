// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, lte } from 'drizzle-orm';
import type { AppDatabase } from '../client.js';
import { BaseRepository } from '../repository.js';
import { triggerConfigs } from '../schema.js';
import type { TriggerConfig } from '../schema.js';

/**
 * 公开 Webhook 与 Worker 调度无法预知租户，只能按 projectId/tokenHash 或到期时间
 * 查询。该仓储只返回触发器配置本身，业务查询仍使用 TenantScopedRepository。
 */
export class TriggerGlobalRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  findByTokenHash(projectId: string, tokenHash: string): TriggerConfig | undefined {
    return this.db
      .select()
      .from(triggerConfigs)
      .where(and(eq(triggerConfigs.projectId, projectId), eq(triggerConfigs.tokenHash, tokenHash)))
      .get();
  }

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

  updateSchedule(id: string, input: { lastFiredAt: number; nextRunAt: number | null }): void {
    this.db
      .update(triggerConfigs)
      .set({
        lastFiredAt: input.lastFiredAt,
        nextRunAt: input.nextRunAt,
        updatedAt: input.lastFiredAt,
      })
      .where(eq(triggerConfigs.id, id))
      .run();
  }
}
