// 本文件所有改动要求遵循 agent-rules 规范
import { eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import { TENANT_STATUS } from '@gait/shared';
import type { TenantStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow } from '../repository.js';
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

  async create(input: CreateTenantInput): Promise<Tenant> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
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
      .returning();

    return requireRow(row);
  }

  async findById(id: string): Promise<Tenant | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);

    return row;
  }

  async findBySlug(slug: string): Promise<Tenant | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);

    return row;
  }

  async updateName(tenantId: string, name: string, now: number = nowMs()): Promise<boolean> {
    const result = await this.db
      .update(tenants)
      .set({ name, updatedAt: now })
      .where(eq(tenants.id, tenantId));

    return (result.rowCount ?? 0) > 0;
  }
}
