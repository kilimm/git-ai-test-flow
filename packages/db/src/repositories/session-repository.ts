// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq, isNull, lt, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { BaseRepository } from '../repository.js';
import { sessions } from '../schema.js';
import type { Session } from '../schema.js';

export interface CreateSessionInput {
  id?: string;
  userId: string;
  tenantId: string | null;
  tokenHash: string;
  expiresAt: number;
  lastSeenAt?: number;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
}

/** 会话仓储；调用方只能提供 token 的 SHA-256 哈希，明文 token 不落库。 */
export class SessionRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  create(input: CreateSessionInput): Session {
    const now = input.now ?? nowMs();

    return this.db
      .insert(sessions)
      .values({
        id: input.id ?? uuidv7(now),
        userId: input.userId,
        tenantId: input.tenantId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        lastSeenAt: input.lastSeenAt ?? now,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        createdAt: now,
      })
      .returning()
      .get();
  }

  findById(id: string): Session | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  findByTokenHash(tokenHash: string): Session | undefined {
    return this.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
  }

  touchLastSeen(sessionId: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .run();

    return result.changes > 0;
  }

  setActiveTenant(sessionId: string, tenantId: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(sessions)
      .set({ tenantId, lastSeenAt: now })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .run();

    return result.changes > 0;
  }

  revoke(sessionId: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .run();

    return result.changes > 0;
  }

  revokeByTokenHash(tokenHash: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .run();

    return result.changes > 0;
  }

  /** 修改密码后撤销其它会话；可以保留当前会话。 */
  revokeAllForUser(userId: string, now: number = nowMs(), exceptSessionId?: string): number {
    const conditions: SQL[] = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];

    if (exceptSessionId !== undefined) {
      conditions.push(ne(sessions.id, exceptSessionId));
    }

    const result = this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(...conditions))
      .run();

    return result.changes;
  }

  /** 成员被移出租户后，强制其以该租户为活动租户的会话失效。 */
  revokeForUserInTenant(userId: string, tenantId: string, now: number = nowMs()): number {
    const result = this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.tenantId, tenantId),
          isNull(sessions.revokedAt),
        ),
      )
      .run();

    return result.changes;
  }

  deleteExpired(now: number = nowMs()): number {
    const result = this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();

    return result.changes;
  }
}
