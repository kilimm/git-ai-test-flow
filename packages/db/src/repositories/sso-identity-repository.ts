// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { ssoIdentities } from '../schema.js';
import type { SsoIdentity } from '../schema.js';

export class SsoIdentityRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async find(providerId: string, subject: string): Promise<SsoIdentity | undefined> {
    const [row] = await this.db
      .select()
      .from(ssoIdentities)
      .where(
        and(
          eq(ssoIdentities.tenantId, this.tenantId),
          eq(ssoIdentities.providerId, providerId),
          eq(ssoIdentities.subject, subject),
        ),
      )
      .limit(1);

    return row;
  }

  async create(input: {
    providerId: string;
    subject: string;
    userId: string;
    now?: number;
  }): Promise<SsoIdentity> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(ssoIdentities)
      .values({
        providerId: input.providerId,
        subject: input.subject,
        tenantId: this.tenantId,
        userId: input.userId,
        createdAt: now,
        lastLoginAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async touch(providerId: string, subject: string, now = nowMs()): Promise<void> {
    await this.db
      .update(ssoIdentities)
      .set({ lastLoginAt: now })
      .where(
        and(
          eq(ssoIdentities.tenantId, this.tenantId),
          eq(ssoIdentities.providerId, providerId),
          eq(ssoIdentities.subject, subject),
        ),
      );
  }
}
