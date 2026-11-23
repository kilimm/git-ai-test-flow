// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs } from '@gait/config';
import { ProjectRepository, TriggerGlobalRepository } from '@gait/db';
import type { AppDatabase, TriggerConfig } from '@gait/db';
import { TriggerEngine } from '@gait/agent';
import type { WorkerLogger } from './worker.js';

export interface TriggerSchedulerOptions {
  db: AppDatabase;
  logger: WorkerLogger;
  intervalMs?: number;
  now?: () => number;
}

/**
 * 定时触发轮询：跨租户读取到期 schedule，调用与原 API 相同的 TriggerEngine。
 * next_run_at 在每次处理（含跳过）后推进，避免失败任务形成忙循环。
 */
export class TriggerScheduler {
  private readonly db: AppDatabase;
  private readonly logger: WorkerLogger;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly engine: TriggerEngine;
  private readonly global: TriggerGlobalRepository;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: TriggerSchedulerOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.now = options.now ?? (() => nowMs());
    this.engine = new TriggerEngine({ db: options.db, now: this.now });
    this.global = new TriggerGlobalRepository(options.db);
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    const tick = (): void => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, 'trigger scheduler failed');
      });
    };

    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<number> {
    if (this.running) {
      return 0;
    }

    this.running = true;
    let fired = 0;

    try {
      const now = this.now();
      const due = await this.global.listDue(now);

      for (const trigger of due) {
        await this.fire(trigger, now);
        fired += 1;
      }
    } finally {
      this.running = false;
    }

    return fired;
  }

  private async fire(trigger: TriggerConfig, now: number): Promise<void> {
    const project = await new ProjectRepository(this.db, trigger.tenantId).findById(
      trigger.projectId,
    );

    if (project === undefined) {
      await this.global.updateSchedule(trigger.id, {
        lastFiredAt: now,
        nextRunAt: this.engine.nextRunAt(trigger.cron, new Date(now)),
      });

      return;
    }

    try {
      const result = await this.engine.fire({ trigger, project });

      this.logger.info(
        {
          triggerId: trigger.id,
          projectId: project.id,
          kind: result.kind,
          resultId: result.id,
          created: result.created,
          reason: result.reason,
        },
        'scheduled trigger fired',
      );
    } catch (error) {
      this.logger.warn(
        { triggerId: trigger.id, err: error instanceof Error ? error.message : String(error) },
        'scheduled trigger failed',
      );
    } finally {
      await this.global.updateSchedule(trigger.id, {
        lastFiredAt: now,
        nextRunAt: this.engine.nextRunAt(trigger.cron, new Date(now)),
      });
    }
  }
}
