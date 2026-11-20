// 本文件所有改动要求遵循 agent-rules 规范
import { eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import { TENANT_STATUS } from '@gait/shared';
import type { TenantStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository } from '../repository.js';
import { tenants } from '../schema.js';
import type { Tenant } from '../schema.js';

export interface CreateTenantInput {
  id?: string;
  slug: string;
  name: string;
  status?: TenantStatus;
  settingsJson?: string;
  now?: number;
}

export class TenantRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  create(input: CreateTenantInput): Tenant {
    const now = input.now ?? nowMs();

    return this.db
      .insert(tenants)
      .values({
        id: input.id ?? uuidv7(now),
        slug: input.slug,
        name: input.name,
        status: input.status ?? TENANT_STATUS.ACTIVE,
        settingsJson: input.settingsJson ?? '{}',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  findById(id: string): Tenant | undefined {
    return this.db.select().from(tenants).where(eq(tenants.id, id)).get();
  }

  findBySlug(slug: string): Tenant | undefined {
    return this.db.select().from(tenants).where(eq(tenants.slug, slug)).get();
  }

  updateName(tenantId: string, name: string, now: number = nowMs()): boolean {
    const result = this.db
      .update(tenants)
      .set({ name, updatedAt: now })
      .where(eq(tenants.id, tenantId))
      .run();

    return result.changes > 0;
  }
}
