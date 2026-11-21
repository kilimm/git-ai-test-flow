// 本文件所有改动要求遵循 agent-rules 规范
import { desc, eq, gte } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { BaseRepository } from '../repository.js';
import { runnerNodes } from '../schema.js';
import type { RunnerNode } from '../schema.js';

export interface RegisterRunnerInput {
  name: string;
  tokenHash: string;
  capacity?: number;
  version?: string | null;
  now?: number;
}

/** Runner 是全局资源（不属于租户），注册与心跳由平台运维/Worker 使用。 */
export class RunnerNodeRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  register(input: RegisterRunnerInput): RunnerNode {
    const now = input.now ?? nowMs();

    return this.db
      .insert(runnerNodes)
      .values({
        id: uuidv7(now),
        name: input.name,
        tokenHash: input.tokenHash,
        capacity: input.capacity ?? 1,
        status: 'online',
        version: input.version ?? null,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  list(): RunnerNode[] {
    return this.db.select().from(runnerNodes).orderBy(desc(runnerNodes.updatedAt)).all();
  }

  findByName(name: string): RunnerNode | undefined {
    return this.db.select().from(runnerNodes).where(eq(runnerNodes.name, name)).get();
  }

  findById(id: string): RunnerNode | undefined {
    return this.db.select().from(runnerNodes).where(eq(runnerNodes.id, id)).get();
  }

  heartbeat(
    name: string,
    input: { version?: string | null; capacity?: number } = {},
    now = nowMs(),
  ): RunnerNode | undefined {
    return this.db
      .update(runnerNodes)
      .set({
        status: 'online',
        lastHeartbeatAt: now,
        updatedAt: now,
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      })
      .where(eq(runnerNodes.name, name))
      .returning()
      .get();
  }

  listOnline(since: number): RunnerNode[] {
    return this.db.select().from(runnerNodes).where(gte(runnerNodes.lastHeartbeatAt, since)).all();
  }

  markOffline(name: string, now = nowMs()): void {
    this.db
      .update(runnerNodes)
      .set({ status: 'offline', updatedAt: now })
      .where(eq(runnerNodes.name, name))
      .run();
  }

  remove(id: string): boolean {
    return this.db.delete(runnerNodes).where(eq(runnerNodes.id, id)).run().changes > 0;
  }
}
