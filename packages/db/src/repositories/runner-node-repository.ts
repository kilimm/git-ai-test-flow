// 本文件所有改动要求遵循 agent-rules 规范
import { desc, eq, gte } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow } from '../repository.js';
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

  async register(input: RegisterRunnerInput): Promise<RunnerNode> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
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
      .returning();

    return requireRow(row);
  }

  async list(): Promise<RunnerNode[]> {
    return this.db.select().from(runnerNodes).orderBy(desc(runnerNodes.updatedAt));
  }

  async findByName(name: string): Promise<RunnerNode | undefined> {
    const [row] = await this.db
      .select()
      .from(runnerNodes)
      .where(eq(runnerNodes.name, name))
      .limit(1);

    return row;
  }

  async findById(id: string): Promise<RunnerNode | undefined> {
    const [row] = await this.db.select().from(runnerNodes).where(eq(runnerNodes.id, id)).limit(1);

    return row;
  }

  async heartbeat(
    name: string,
    input: { version?: string | null; capacity?: number } = {},
    now = nowMs(),
  ): Promise<RunnerNode | undefined> {
    const [row] = await this.db
      .update(runnerNodes)
      .set({
        status: 'online',
        lastHeartbeatAt: now,
        updatedAt: now,
        ...(input.version === undefined ? {} : { version: input.version }),
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      })
      .where(eq(runnerNodes.name, name))
      .returning();

    return row;
  }

  async listOnline(since: number): Promise<RunnerNode[]> {
    return this.db.select().from(runnerNodes).where(gte(runnerNodes.lastHeartbeatAt, since));
  }

  async markOffline(name: string, now = nowMs()): Promise<void> {
    await this.db
      .update(runnerNodes)
      .set({ status: 'offline', updatedAt: now })
      .where(eq(runnerNodes.name, name));
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.delete(runnerNodes).where(eq(runnerNodes.id, id));

    return (result.rowCount ?? 0) > 0;
  }
}
