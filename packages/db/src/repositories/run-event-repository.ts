// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, gt, max } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { runEvents } from '../schema.js';
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

  append(input: AppendRunEventInput): RunEvent {
    const now = input.now ?? nowMs();
    const current = this.db
      .select({ value: max(runEvents.seq) })
      .from(runEvents)
      .where(and(eq(runEvents.tenantId, this.tenantId), eq(runEvents.runId, input.runId)))
      .get();
    const seq = (current?.value ?? 0) + 1;

    return this.db
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
      .returning()
      .get();
  }

  listByRun(runId: string, sinceSeq = 0): RunEvent[] {
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
      .orderBy(runEvents.seq)
      .all();
  }
}
