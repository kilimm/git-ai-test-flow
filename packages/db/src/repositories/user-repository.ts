// 本文件所有改动要求遵循 agent-rules 规范
import { eq, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import { USER_STATUS } from '@gait/shared';
import type { UserStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository } from '../repository.js';
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

  create(input: CreateUserInput): User {
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

    return this.db.insert(users).values(row).returning().get();
  }

  findById(id: string): User | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  findByUsername(username: string): User | undefined {
    return this.db.select().from(users).where(eq(users.username, username)).get();
  }

  findByEmail(email: string): User | undefined {
    return this.db.select().from(users).where(eq(users.email, email)).get();
  }

  countPlatformAdmins(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.isPlatformAdmin, true))
      .get();

    return row?.count ?? 0;
  }

  updatePasswordHash(userId: string, passwordHash: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(users)
      .set({ passwordHash, updatedAt: now })
      .where(eq(users.id, userId))
      .run();

    return result.changes > 0;
  }

  recordLogin(userId: string, now: number = nowMs()): void {
    this.db
      .update(users)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
  }
}
