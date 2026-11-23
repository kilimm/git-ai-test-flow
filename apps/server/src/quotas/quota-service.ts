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

  async get(context: AuthContext): Promise<QuotaView> {
    const quota = await new TenantQuotaRepository(this.db).get(context.tenant.id);
    const usage = await new TenantUsageRepository(this.db, context.tenant.id).snapshot(this.now());

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

  async update(
    context: AuthContext,
    input: {
      maxRunsPerDay?: number | undefined;
      maxConcurrentRuns?: number | undefined;
      maxLlmTokensPerMonth?: number | undefined;
    },
  ): Promise<QuotaView> {
    await new TenantQuotaRepository(this.db).update(context.tenant.id, input, this.now());

    return await this.get(context);
  }

  /** 传入事务执行器时，配额检查与随后的插入在同一事务内完成。 */
  async assertRunAllowed(context: AuthContext, executor: AppDatabase = this.db): Promise<void> {
    const quota = await new TenantQuotaRepository(executor).get(context.tenant.id);
    const usage = await new TenantUsageRepository(executor, context.tenant.id).snapshot(this.now());

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
