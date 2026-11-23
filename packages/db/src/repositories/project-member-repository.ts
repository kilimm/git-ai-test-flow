// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { ProjectRole } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { projectMembers, projects } from '../schema.js';
import type { ProjectMember } from '../schema.js';

export interface AddProjectMemberInput {
  projectId: string;
  userId: string;
  role: ProjectRole;
  now?: number;
}

/** 项目成员只影响 restricted 项目；查询仍强制 tenant_id。 */
export class ProjectMemberRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async listByProject(projectId: string): Promise<ProjectMember[]> {
    const rows = await this.db
      .select({ member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.tenantId, this.tenantId), eq(projectMembers.projectId, projectId)));

    return rows.map((row) => row.member);
  }

  async listByUser(userId: string): Promise<ProjectMember[]> {
    const rows = await this.db
      .select({ member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.tenantId, this.tenantId), eq(projectMembers.userId, userId)));

    return rows.map((row) => row.member);
  }

  async find(projectId: string, userId: string): Promise<ProjectMember | undefined> {
    const [row] = await this.db
      .select({ member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projects.tenantId, this.tenantId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1);

    return row?.member;
  }

  async upsert(input: AddProjectMemberInput): Promise<ProjectMember> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(projectMembers)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: input.role, updatedAt: now },
      })
      .returning();

    return requireRow(row);
  }

  async remove(projectId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));

    return (result.rowCount ?? 0) > 0;
  }

  async countByProject(projectId: string): Promise<number> {
    return (await this.listByProject(projectId)).length;
  }
}
