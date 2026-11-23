// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { environmentGroups } from '../schema.js';
import type { EnvironmentGroup } from '../schema.js';

export interface CreateEnvironmentGroupInput {
  id?: string;
  projectId: string;
  name: string;
  description?: string;
  now?: number;
}

export class EnvironmentGroupRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async listByProject(projectId: string): Promise<EnvironmentGroup[]> {
    return this.db
      .select()
      .from(environmentGroups)
      .where(
        and(
          eq(environmentGroups.tenantId, this.tenantId),
          eq(environmentGroups.projectId, projectId),
        ),
      );
  }

  async findById(id: string): Promise<EnvironmentGroup | undefined> {
    const [row] = await this.db
      .select()
      .from(environmentGroups)
      .where(and(eq(environmentGroups.id, id), eq(environmentGroups.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async create(input: CreateEnvironmentGroupInput): Promise<EnvironmentGroup> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(environmentGroups)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(environmentGroups)
      .where(and(eq(environmentGroups.id, id), eq(environmentGroups.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }
}
