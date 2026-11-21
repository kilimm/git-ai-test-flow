// 本文件所有改动要求遵循 agent-rules 规范
import { desc, gte } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { workerHeartbeats } from '../schema.js';
import type { WorkerHeartbeat } from '../schema.js';

export interface WorkerHeartbeatInput {
  workerId: string;
  status?: string;
  details?: Record<string, unknown>;
  now?: number;
}

/** Worker 存活状态；只记录非敏感运行元数据（并发、版本、队列轮询时间）。 */
export class WorkerHeartbeatRepository {
  constructor(private readonly db: AppDatabase) {}

  record(input: WorkerHeartbeatInput): WorkerHeartbeat {
    const now = input.now ?? nowMs();

    return this.db
      .insert(workerHeartbeats)
      .values({
        workerId: input.workerId,
        lastSeenAt: now,
        status: input.status ?? 'idle',
        detailsJson: JSON.stringify(input.details ?? {}),
      })
      .onConflictDoUpdate({
        target: workerHeartbeats.workerId,
        set: {
          lastSeenAt: now,
          status: input.status ?? 'idle',
          detailsJson: JSON.stringify(input.details ?? {}),
        },
      })
      .returning()
      .get() as WorkerHeartbeat;
  }

  listSince(since: number): WorkerHeartbeat[] {
    return this.db
      .select()
      .from(workerHeartbeats)
      .where(gte(workerHeartbeats.lastSeenAt, since))
      .orderBy(desc(workerHeartbeats.lastSeenAt))
      .all();
  }

  latest(): WorkerHeartbeat | undefined {
    return this.db
      .select()
      .from(workerHeartbeats)
      .orderBy(desc(workerHeartbeats.lastSeenAt))
      .limit(1)
      .get();
  }
}
