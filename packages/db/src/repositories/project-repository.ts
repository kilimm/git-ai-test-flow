// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { SuiteMode } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { projects } from '../schema.js';
import type { NewProject, Project } from '../schema.js';

export interface CreateProjectInput {
  id?: string;
  name: string;
  slug: string;
  productRepoUrl: string;
  defaultBranch: string;
  gitCredentialId?: string | null;
  suiteMode: SuiteMode;
  suiteRepoUrl?: string | null;
  suitePath?: string | null;
  featureRoot: string;
  docsRoot: string;
  settingsJson?: string;
  createdByUserId?: string | null;
  now?: number;
}

export interface UpdateProjectInput {
  name?: string;
  productRepoUrl?: string;
  defaultBranch?: string;
  gitCredentialId?: string | null;
  suiteMode?: SuiteMode;
  suiteRepoUrl?: string | null;
  suitePath?: string | null;
  featureRoot?: string;
  docsRoot?: string;
  settingsJson?: string;
}

export class ProjectRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateProjectInput): Project {
    const now = input.now ?? nowMs();

    return this.db
      .insert(projects)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        name: input.name,
        slug: input.slug,
        productRepoUrl: input.productRepoUrl,
        defaultBranch: input.defaultBranch,
        gitCredentialId: input.gitCredentialId ?? null,
        suiteMode: input.suiteMode,
        suiteRepoUrl: input.suiteRepoUrl ?? null,
        suitePath: input.suitePath ?? null,
        featureRoot: input.featureRoot,
        docsRoot: input.docsRoot,
        settingsJson: input.settingsJson ?? '{}',
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  list(): Project[] {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.tenantId, this.tenantId))
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .all();
  }

  findById(id: string): Project | undefined {
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)))
      .get();
  }

  findBySlug(slug: string): Project | undefined {
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.slug, slug), eq(projects.tenantId, this.tenantId)))
      .get();
  }

  update(id: string, input: UpdateProjectInput, now: number = nowMs()): Project | undefined {
    const values: Partial<NewProject> = { updatedAt: now };

    if (input.name !== undefined) {
      values.name = input.name;
    }

    if (input.productRepoUrl !== undefined) {
      values.productRepoUrl = input.productRepoUrl;
    }

    if (input.defaultBranch !== undefined) {
      values.defaultBranch = input.defaultBranch;
    }

    if (input.gitCredentialId !== undefined) {
      values.gitCredentialId = input.gitCredentialId;
    }

    if (input.suiteMode !== undefined) {
      values.suiteMode = input.suiteMode;
    }

    if (input.suiteRepoUrl !== undefined) {
      values.suiteRepoUrl = input.suiteRepoUrl;
    }

    if (input.suitePath !== undefined) {
      values.suitePath = input.suitePath;
    }

    if (input.featureRoot !== undefined) {
      values.featureRoot = input.featureRoot;
    }

    if (input.docsRoot !== undefined) {
      values.docsRoot = input.docsRoot;
    }

    if (input.settingsJson !== undefined) {
      values.settingsJson = input.settingsJson;
    }

    return this.db
      .update(projects)
      .set(values)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)))
      .returning()
      .get();
  }

  /** 项目删除依赖外键级联清理 LLM/环境/通知渠道。 */
  remove(id: string): boolean {
    const result = this.db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)))
      .run();

    return result.changes > 0;
  }

  countByCredential(credentialId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(projects)
      .where(and(eq(projects.tenantId, this.tenantId), eq(projects.gitCredentialId, credentialId)))
      .get();

    return row?.count ?? 0;
  }
}
