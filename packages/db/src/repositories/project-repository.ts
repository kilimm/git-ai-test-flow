// 本文件所有改动要求遵循 agent-rules 规范
import { and, count, desc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { CaseStorage, ProjectAccessMode, SuiteMode } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
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
  accessMode?: ProjectAccessMode;
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
  caseStorage?: CaseStorage;
  settingsJson?: string;
  accessMode?: ProjectAccessMode;
}

export class ProjectRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
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
        accessMode: input.accessMode ?? 'tenant',
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async list(): Promise<Project[]> {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.tenantId, this.tenantId))
      .orderBy(desc(projects.createdAt), desc(projects.id));
  }

  async findById(id: string): Promise<Project | undefined> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async findBySlug(slug: string): Promise<Project | undefined> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.slug, slug), eq(projects.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    now: number = nowMs(),
  ): Promise<Project | undefined> {
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

    if (input.caseStorage !== undefined) {
      values.caseStorage = input.caseStorage;
    }

    if (input.settingsJson !== undefined) {
      values.settingsJson = input.settingsJson;
    }

    if (input.accessMode !== undefined) {
      values.accessMode = input.accessMode;
    }

    const [row] = await this.db
      .update(projects)
      .set(values)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)))
      .returning();

    return row;
  }

  /** 项目删除依赖外键级联清理 LLM/环境/通知渠道。 */
  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.tenantId, this.tenantId)));

    return (result.rowCount ?? 0) > 0;
  }

  async countByCredential(credentialId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(projects)
      .where(and(eq(projects.tenantId, this.tenantId), eq(projects.gitCredentialId, credentialId)));

    return row?.count ?? 0;
  }
}
