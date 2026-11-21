// 本文件所有改动要求遵循 agent-rules 规范
import { AppError } from '@gait/config';
import { TenantQuotaRepository, TenantUsageRepository } from '@gait/db';
import type { AppDatabase, TenantQuota } from '@gait/db';
import type { AuthContext } from '../auth/auth-service.js';

export interface QuotaView extends TenantQuota {
  usage: {
    runsToday: number;
    activeRuns: number;
    failedRuns: number;
    llmInputTokens: number;
    llmOutputTokens: number;
  };
}

function quotaError(code: string, detail: string): AppError {
  return new AppError(detail, { status: 429, code, detail });
}

/** 租户配额：默认值足够普通团队，管理员可通过 API 下调。 */
export class QuotaService {
  private readonly db: AppDatabase;
  private readonly now: () => number;

  constructor(options: { db: AppDatabase; now?: () => number }) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
  }

  get(context: AuthContext): QuotaView {
    const quota = new TenantQuotaRepository(this.db).get(context.tenant.id);
    const usage = new TenantUsageRepository(this.db, context.tenant.id).snapshot(this.now());

    return {
      ...quota,
      usage: {
        runsToday: usage.runsToday,
        activeRuns: usage.activeRuns,
        failedRuns: usage.failedRuns,
        llmInputTokens: usage.llmInputTokens,
        llmOutputTokens: usage.llmOutputTokens,
      },
    };
  }

  update(
    context: AuthContext,
    input: {
      maxRunsPerDay?: number | undefined;
      maxConcurrentRuns?: number | undefined;
      maxLlmTokensPerMonth?: number | undefined;
    },
  ): QuotaView {
    new TenantQuotaRepository(this.db).update(context.tenant.id, input, this.now());

    return this.get(context);
  }

  assertRunAllowed(context: AuthContext): void {
    const quota = new TenantQuotaRepository(this.db).get(context.tenant.id);
    const usage = new TenantUsageRepository(this.db, context.tenant.id).snapshot(this.now());

    if (usage.activeRuns >= quota.maxConcurrentRuns) {
      throw quotaError(
        'QUOTA_CONCURRENT_RUNS_EXCEEDED',
        `Concurrent run quota exceeded (${quota.maxConcurrentRuns})`,
      );
    }

    if (usage.runsToday >= quota.maxRunsPerDay) {
      throw quotaError(
        'QUOTA_DAILY_RUNS_EXCEEDED',
        `Daily run quota exceeded (${quota.maxRunsPerDay})`,
      );
    }

    if (usage.llmInputTokens + usage.llmOutputTokens >= quota.maxLlmTokensPerMonth) {
      throw quotaError(
        'QUOTA_LLM_TOKENS_EXCEEDED',
        `Monthly LLM token quota exceeded (${quota.maxLlmTokensPerMonth})`,
      );
    }
  }
}
