// 本文件所有改动要求遵循 agent-rules 规范
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { BaseRepository, TenantScopedRepository } from '../repository.js';
import { runs, tenantQuotas } from '../schema.js';
import type { TenantQuota } from '../schema.js';

export interface UpdateTenantQuotaInput {
  maxRunsPerDay?: number | undefined;
  maxConcurrentRuns?: number | undefined;
  maxLlmTokensPerMonth?: number | undefined;
}

export class TenantQuotaRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  get(tenantId: string): TenantQuota {
    const existing = this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId))
      .get();

    if (existing !== undefined) {
      return existing;
    }

    return this.db.insert(tenantQuotas).values({ tenantId, updatedAt: nowMs() }).returning().get();
  }

  update(tenantId: string, input: UpdateTenantQuotaInput, now = nowMs()): TenantQuota {
    const current = this.get(tenantId);

    return this.db
      .update(tenantQuotas)
      .set({
        maxRunsPerDay: input.maxRunsPerDay ?? current.maxRunsPerDay,
        maxConcurrentRuns: input.maxConcurrentRuns ?? current.maxConcurrentRuns,
        maxLlmTokensPerMonth: input.maxLlmTokensPerMonth ?? current.maxLlmTokensPerMonth,
        updatedAt: now,
      })
      .where(eq(tenantQuotas.tenantId, tenantId))
      .returning()
      .get();
  }
}

export interface TenantUsageSnapshot {
  runsToday: number;
  activeRuns: number;
  failedRuns: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}

/** 月度/日度用量从 runs/stats_json 聚合；不额外维护易漂移的计数表。 */
export class TenantUsageRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  snapshot(now = nowMs()): TenantUsageSnapshot {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const dayRows = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), gte(runs.createdAt, dayStart.getTime())))
      .all();
    const monthRows = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), gte(runs.createdAt, monthStart.getTime())))
      .all();
    const active = this.db
      .select({ value: count() })
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, this.tenantId),
          inArray(runs.status, ['queued', 'preparing', 'running', 'analyzing', 'reporting']),
        ),
      )
      .get();
    let llmInputTokens = 0;
    let llmOutputTokens = 0;

    for (const run of monthRows) {
      try {
        const stats = JSON.parse(run.statsJson) as {
          analysis?: { llmInputTokens?: number; llmOutputTokens?: number };
        };

        llmInputTokens += stats.analysis?.llmInputTokens ?? 0;
        llmOutputTokens += stats.analysis?.llmOutputTokens ?? 0;
      } catch {
        // 统计损坏时按 0 处理。
      }
    }

    return {
      runsToday: dayRows.length,
      activeRuns: active?.value ?? 0,
      failedRuns: monthRows.filter((run) => run.status === 'failed').length,
      llmInputTokens,
      llmOutputTokens,
    };
  }
}
