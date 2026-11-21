// 本文件所有改动要求遵循 agent-rules 规范
import { and, eq } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import type { ProjectRole } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
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

  listByProject(projectId: string): ProjectMember[] {
    return this.db
      .select({ member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.tenantId, this.tenantId), eq(projectMembers.projectId, projectId)))
      .all()
      .map((row) => row.member);
  }

  listByUser(userId: string): ProjectMember[] {
    return this.db
      .select({ member: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.tenantId, this.tenantId), eq(projectMembers.userId, userId)))
      .all()
      .map((row) => row.member);
  }

  find(projectId: string, userId: string): ProjectMember | undefined {
    return this.db
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
      .get()?.member;
  }

  upsert(input: AddProjectMemberInput): ProjectMember {
    const now = input.now ?? nowMs();

    return this.db
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
      .returning()
      .get() as ProjectMember;
  }

  remove(projectId: string, userId: string): boolean {
    const result = this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .run();

    return result.changes > 0;
  }

  countByProject(projectId: string): number {
    return this.listByProject(projectId).length;
  }
}
