// 本文件所有改动要求遵循 agent-rules 规范
import { ValidationError } from '@gait/config';
import { CredentialRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, Project } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  DEFAULT_SUITE_PATH,
  normalizeRepoDir,
} from '@gait/shared';
import type { ProjectAccessMode, SuiteMode } from '@gait/shared';
import type { CreateProjectBody, UpdateProjectBody } from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
import type { ProjectAccessService } from './project-access-service.js';
import type { ConfigServiceDeps } from './support.js';
import {
  parseJsonObject,
  requireCredential,
  requireProject,
  settingsJsonFor,
  writeConfigAudit,
} from './support.js';

export interface ProjectView {
  id: string;
  name: string;
  slug: string;
  productRepoUrl: string;
  defaultBranch: string;
  gitCredentialId: string | null;
  suiteMode: SuiteMode;
  suiteRepoUrl: string | null;
  suitePath: string | null;
  featureRoot: string;
  docsRoot: string;
  accessMode: ProjectAccessMode;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConnectionResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  durationMs: number;
}

function projectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    productRepoUrl: project.productRepoUrl,
    defaultBranch: project.defaultBranch,
    gitCredentialId: project.gitCredentialId,
    suiteMode: project.suiteMode,
    suiteRepoUrl: project.suiteRepoUrl,
    suitePath: project.suitePath,
    featureRoot: project.featureRoot,
    docsRoot: project.docsRoot,
    accessMode: project.accessMode === 'restricted' ? 'restricted' : 'tenant',
    settings: parseJsonObject(project.settingsJson),
    createdAt: new Date(project.createdAt).toISOString(),
    updatedAt: new Date(project.updatedAt).toISOString(),
  };
}

interface SuiteConfig {
  suiteRepoUrl: string | null;
  suitePath: string | null;
}

function resolveSuiteConfig(
  mode: SuiteMode,
  suiteRepoUrl: string | null | undefined,
  suitePath: string | null | undefined,
): SuiteConfig {
  if (mode === 'external') {
    if ((suiteRepoUrl ?? '').length === 0) {
      throw new ValidationError('suiteRepoUrl is required when suiteMode is external');
    }

    return { suiteRepoUrl: suiteRepoUrl ?? null, suitePath: null };
  }

  if (mode === 'same_repo') {
    return {
      suiteRepoUrl: null,
      suitePath: normalizeRepoDir(suitePath ?? DEFAULT_SUITE_PATH),
    };
  }

  return { suiteRepoUrl: null, suitePath: null };
}

/** 项目服务：所有查询都绑定会话活动租户，路径 ID 无法跨租户命中。 */
export class ProjectService {
  constructor(
    private readonly db: AppDatabase,
    private readonly deps: ConfigServiceDeps,
    private readonly projectAccess?: ProjectAccessService,
  ) {}

  async create(context: AuthContext, input: CreateProjectBody): Promise<ProjectView> {
    const repository = new ProjectRepository(this.db, context.tenant.id);

    if ((await repository.findBySlug(input.slug)) !== undefined) {
      throw new ValidationError('Project slug already exists');
    }

    const gitCredentialId = input.gitCredentialId ?? null;

    if (gitCredentialId !== null) {
      const credential = requireCredential(
        await new CredentialRepository(this.db, context.tenant.id).findById(gitCredentialId),
        CREDENTIAL_TYPE.GIT_PAT,
      );

      if (credential.tenantId !== context.tenant.id) {
        throw new ValidationError('Git credential not found');
      }
    }

    const suite = resolveSuiteConfig(input.suiteMode, input.suiteRepoUrl, input.suitePath);
    const project = await repository.create({
      name: input.name,
      slug: input.slug,
      productRepoUrl: input.productRepoUrl,
      defaultBranch: input.defaultBranch,
      gitCredentialId,
      suiteMode: input.suiteMode,
      suiteRepoUrl: suite.suiteRepoUrl,
      suitePath: suite.suitePath,
      featureRoot: normalizeRepoDir(input.featureRoot),
      docsRoot: normalizeRepoDir(input.docsRoot),
      settingsJson: settingsJsonFor(input.settings),
      createdByUserId: context.user.id,
      now: this.deps.now(),
    });

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_CREATE,
      AUDIT_RESOURCE_TYPE.PROJECT,
      project.id,
      { name: project.name, slug: project.slug, suiteMode: project.suiteMode },
    );

    return projectView(project);
  }

  async list(context: AuthContext): Promise<ProjectView[]> {
    const projects =
      this.projectAccess === undefined
        ? await new ProjectRepository(this.db, context.tenant.id).list()
        : await this.projectAccess.listProjects(context);

    return projects.map(projectView);
  }

  async get(context: AuthContext, projectId: string): Promise<ProjectView> {
    const repository = new ProjectRepository(this.db, context.tenant.id);

    return projectView(await requireProject(repository, projectId));
  }

  async update(
    context: AuthContext,
    projectId: string,
    input: UpdateProjectBody,
  ): Promise<ProjectView> {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const existing = await requireProject(repository, projectId);

    if (input.slug !== undefined && input.slug !== existing.slug) {
      if ((await repository.findBySlug(input.slug)) !== undefined) {
        throw new ValidationError('Project slug already exists');
      }
    }

    let gitCredentialId = input.gitCredentialId;

    if (gitCredentialId !== undefined && gitCredentialId !== null) {
      requireCredential(
        await new CredentialRepository(this.db, context.tenant.id).findById(gitCredentialId),
        CREDENTIAL_TYPE.GIT_PAT,
      );
    }

    if (gitCredentialId === undefined) {
      gitCredentialId = existing.gitCredentialId;
    }

    const suiteMode = input.suiteMode ?? existing.suiteMode;

    if (
      suiteMode !== 'external' &&
      input.suiteRepoUrl !== undefined &&
      input.suiteRepoUrl !== null
    ) {
      throw new ValidationError('suiteRepoUrl is only allowed when suiteMode is external');
    }

    if (suiteMode !== 'same_repo' && input.suitePath !== undefined && input.suitePath !== null) {
      throw new ValidationError('suitePath is only allowed when suiteMode is same_repo');
    }

    const suite = resolveSuiteConfig(
      suiteMode,
      input.suiteRepoUrl !== undefined ? input.suiteRepoUrl : existing.suiteRepoUrl,
      input.suitePath !== undefined ? input.suitePath : existing.suitePath,
    );

    const updated = await repository.update(
      projectId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.productRepoUrl === undefined ? {} : { productRepoUrl: input.productRepoUrl }),
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
        ...(gitCredentialId === undefined ? {} : { gitCredentialId }),
        suiteMode,
        suiteRepoUrl: suite.suiteRepoUrl,
        suitePath: suite.suitePath,
        ...(input.featureRoot === undefined
          ? {}
          : { featureRoot: normalizeRepoDir(input.featureRoot) }),
        ...(input.docsRoot === undefined ? {} : { docsRoot: normalizeRepoDir(input.docsRoot) }),
        ...(input.settings === undefined ? {} : { settingsJson: settingsJsonFor(input.settings) }),
      },
      this.deps.now(),
    );

    if (updated === undefined) {
      throw new ValidationError('Project was not updated');
    }

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_UPDATE,
      AUDIT_RESOURCE_TYPE.PROJECT,
      updated.id,
      { name: updated.name, slug: updated.slug, fields: Object.keys(input) },
    );

    return projectView(updated);
  }

  async remove(context: AuthContext, projectId: string): Promise<void> {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const project = await requireProject(repository, projectId);

    await repository.remove(projectId);
    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_DELETE,
      AUDIT_RESOURCE_TYPE.PROJECT,
      project.id,
      { name: project.name, slug: project.slug },
    );
  }

  /** 项目连通性测试复用 Git 凭据；没有凭据时按公开仓库尝试。 */
  async testConnection(context: AuthContext, projectId: string): Promise<ProjectConnectionResult> {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const project = await requireProject(repository, projectId);
    let username: string | undefined;
    let token: string | undefined;

    if (project.gitCredentialId !== null) {
      const credential = requireCredential(
        await new CredentialRepository(this.db, context.tenant.id).findById(
          project.gitCredentialId,
        ),
        CREDENTIAL_TYPE.GIT_PAT,
      );
      token = this.deps.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
        ciphertext: credential.secretCiphertext,
        iv: credential.secretIv,
        authTag: credential.secretAuthTag,
        keyVersion: credential.keyVersion,
      });
      username = credential.username ?? undefined;
    }

    const result = await this.deps.gitLsRemote({
      repoUrl: project.productRepoUrl,
      ...(username === undefined ? {} : { username }),
      ...(token === undefined ? {} : { token }),
    });

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_TEST_CONNECTION,
      AUDIT_RESOURCE_TYPE.PROJECT,
      project.id,
      { result: result.ok ? 'ok' : 'failed', code: result.code },
    );

    return {
      status: result.ok ? 'ok' : 'failed',
      code: result.code,
      message: result.message,
      durationMs: result.durationMs,
    };
  }
}
