// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, gt, max } from 'drizzle-orm';
import { NotFoundError, nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { runEvents, runs } from '../schema.js';
import type { RunEvent } from '../schema.js';

export interface AppendRunEventInput {
  runId: string;
  type: string;
  payload?: unknown;
  now?: number;
}

/** Run 事件流；seq 在 Run 内从 1 单调递增，SSE 按 Last-Event-ID 续传。 */
export class RunEventRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  /**
   * 追加事件。先对所属 Run 行加锁，串行化同一 Run 的并发追加，
   * 避免 max(seq)+1 在 PostgreSQL 并发下产生重复序号。
   */
  async append(input: AppendRunEventInput): Promise<RunEvent> {
    const now = input.now ?? nowMs();

    return this.db.transaction(async (tx) => {
      // 锁行必须带租户过滤：仓储实例不得锁定或写入其它租户的 Run。
      const [locked] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.tenantId, this.tenantId)))
        .for('update');

      if (locked === undefined) {
        throw new NotFoundError('Run not found');
      }

      const [current] = await tx
        .select({ value: max(runEvents.seq) })
        .from(runEvents)
        .where(and(eq(runEvents.tenantId, this.tenantId), eq(runEvents.runId, input.runId)));
      const seq = (current?.value ?? 0) + 1;
      const [row] = await tx
        .insert(runEvents)
        .values({
          id: uuidv7(now),
          tenantId: this.tenantId,
          runId: input.runId,
          seq,
          type: input.type,
          payloadJson: JSON.stringify(input.payload ?? {}),
          createdAt: now,
        })
        .returning();

      return requireRow(row);
    });
  }

  async listByRun(runId: string, sinceSeq = 0): Promise<RunEvent[]> {
    return this.db
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.tenantId, this.tenantId),
          eq(runEvents.runId, runId),
          gt(runEvents.seq, sinceSeq),
        ),
      )
      .orderBy(runEvents.seq);
  }
}
