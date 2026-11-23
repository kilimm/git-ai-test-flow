// 本文件所有改动要求遵循 agent-rules 规范
import { count, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import { USER_STATUS } from '@gait/shared';
import type { UserStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow } from '../repository.js';
import { users } from '../schema.js';
import type { User } from '../schema.js';

export interface CreateUserInput {
  id?: string;
  username: string;
  email?: string | null;
  passwordHash: string;
  displayName: string;
  status?: UserStatus;
  isPlatformAdmin?: boolean;
  now?: number;
}

/** 用户是全局身份，不做租户过滤；租户隔离由成员与会话仓储保证。 */
export class UserRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  async create(input: CreateUserInput): Promise<User> {
    const now = input.now ?? nowMs();
    const row: typeof users.$inferInsert = {
      id: input.id ?? uuidv7(now),
      username: input.username,
      email: input.email ?? null,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      status: input.status ?? USER_STATUS.ACTIVE,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const [created] = await this.db.insert(users).values(row).returning();

    return requireRow(created);
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);

    return row;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);

    return row;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);

    return row;
  }

  async countPlatformAdmins(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(users)
      .where(eq(users.isPlatformAdmin, true));

    return row?.count ?? 0;
  }

  async updatePasswordHash(
    userId: string,
    passwordHash: string,
    now: number = nowMs(),
  ): Promise<boolean> {
    const result = await this.db
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, userId));

    return (result.rowCount ?? 0) > 0;
  }

  async recordLogin(userId: string, now: number = nowMs()): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  }
}
