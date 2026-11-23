// 本文件所有改动要求遵循 agent-rules 规范
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow, TenantScopedRepository } from '../repository.js';
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

  async get(tenantId: string): Promise<TenantQuota> {
    const [existing] = await this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId))
      .limit(1);

    if (existing !== undefined) {
      return existing;
    }

    // 并发首次访问时由唯一键兜底，避免重复插入。
    await this.db
      .insert(tenantQuotas)
      .values({ tenantId, updatedAt: nowMs() })
      .onConflictDoNothing();
    const [created] = await this.db
      .select()
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId))
      .limit(1);

    return requireRow(created);
  }

  async update(
    tenantId: string,
    input: UpdateTenantQuotaInput,
    now = nowMs(),
  ): Promise<TenantQuota> {
    const current = await this.get(tenantId);
    const [row] = await this.db
      .update(tenantQuotas)
      .set({
        maxRunsPerDay: input.maxRunsPerDay ?? current.maxRunsPerDay,
        maxConcurrentRuns: input.maxConcurrentRuns ?? current.maxConcurrentRuns,
        maxLlmTokensPerMonth: input.maxLlmTokensPerMonth ?? current.maxLlmTokensPerMonth,
        updatedAt: now,
      })
      .where(eq(tenantQuotas.tenantId, tenantId))
      .returning();

    return requireRow(row);
  }
}

export interface TenantUsageSnapshot {
  runsToday: number;
  activeRuns: number;
  failedRuns: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}

const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'analyzing', 'reporting'] as const;

/** 月度/日度用量从 runs/stats_json 聚合；不额外维护易漂移的计数表。 */
export class TenantUsageRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async snapshot(now = nowMs()): Promise<TenantUsageSnapshot> {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [runsTodayRow] = await this.db
      .select({ value: count() })
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), gte(runs.createdAt, dayStart.getTime())));
    const [activeRow] = await this.db
      .select({ value: count() })
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])));
    const [failedRow] = await this.db
      .select({ value: count() })
      .from(runs)
      .where(
        and(
          eq(runs.tenantId, this.tenantId),
          eq(runs.status, 'failed'),
          gte(runs.createdAt, monthStart.getTime()),
        ),
      );
    const monthRows = await this.db
      .select({ statsJson: runs.statsJson })
      .from(runs)
      .where(and(eq(runs.tenantId, this.tenantId), gte(runs.createdAt, monthStart.getTime())));
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
      runsToday: runsTodayRow?.value ?? 0,
      activeRuns: activeRow?.value ?? 0,
      failedRuns: failedRow?.value ?? 0,
      llmInputTokens,
      llmOutputTokens,
    };
  }
}
