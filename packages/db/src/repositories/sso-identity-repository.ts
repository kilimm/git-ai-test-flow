// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { ssoIdentities } from '../schema.js';
import type { SsoIdentity } from '../schema.js';

export class SsoIdentityRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  find(providerId: string, subject: string): SsoIdentity | undefined {
    return this.db
      .select()
      .from(ssoIdentities)
      .where(
        and(
          eq(ssoIdentities.tenantId, this.tenantId),
          eq(ssoIdentities.providerId, providerId),
          eq(ssoIdentities.subject, subject),
        ),
      )
      .get();
  }

  create(input: {
    providerId: string;
    subject: string;
    userId: string;
    now?: number;
  }): SsoIdentity {
    const now = input.now ?? nowMs();

    return this.db
      .insert(ssoIdentities)
      .values({
        providerId: input.providerId,
        subject: input.subject,
        tenantId: this.tenantId,
        userId: input.userId,
        createdAt: now,
        lastLoginAt: now,
      })
      .returning()
      .get();
  }

  touch(providerId: string, subject: string, now = nowMs()): void {
    this.db
      .update(ssoIdentities)
      .set({ lastLoginAt: now })
      .where(
        and(
          eq(ssoIdentities.tenantId, this.tenantId),
          eq(ssoIdentities.providerId, providerId),
          eq(ssoIdentities.subject, subject),
        ),
      )
      .run();
  }
}
