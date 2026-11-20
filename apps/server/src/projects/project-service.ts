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
import type { SuiteMode } from '@gait/shared';
import type { CreateProjectBody, UpdateProjectBody } from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
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
  ) {}

  create(context: AuthContext, input: CreateProjectBody): ProjectView {
    const repository = new ProjectRepository(this.db, context.tenant.id);

    if (repository.findBySlug(input.slug) !== undefined) {
      throw new ValidationError('Project slug already exists');
    }

    const gitCredentialId = input.gitCredentialId ?? null;

    if (gitCredentialId !== null) {
      const credential = requireCredential(
        new CredentialRepository(this.db, context.tenant.id).findById(gitCredentialId),
        CREDENTIAL_TYPE.GIT_PAT,
      );

      if (credential.tenantId !== context.tenant.id) {
        throw new ValidationError('Git credential not found');
      }
    }

    const suite = resolveSuiteConfig(input.suiteMode, input.suiteRepoUrl, input.suitePath);
    const project = repository.create({
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

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_CREATE,
      AUDIT_RESOURCE_TYPE.PROJECT,
      project.id,
      { name: project.name, slug: project.slug, suiteMode: project.suiteMode },
    );

    return projectView(project);
  }

  list(context: AuthContext): ProjectView[] {
    return new ProjectRepository(this.db, context.tenant.id).list().map(projectView);
  }

  get(context: AuthContext, projectId: string): ProjectView {
    const repository = new ProjectRepository(this.db, context.tenant.id);

    return projectView(requireProject(repository, projectId));
  }

  update(context: AuthContext, projectId: string, input: UpdateProjectBody): ProjectView {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const existing = requireProject(repository, projectId);

    if (input.slug !== undefined && input.slug !== existing.slug) {
      if (repository.findBySlug(input.slug) !== undefined) {
        throw new ValidationError('Project slug already exists');
      }
    }

    let gitCredentialId = input.gitCredentialId;

    if (gitCredentialId !== undefined && gitCredentialId !== null) {
      requireCredential(
        new CredentialRepository(this.db, context.tenant.id).findById(gitCredentialId),
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

    const updated = repository.update(
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

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.PROJECT_UPDATE,
      AUDIT_RESOURCE_TYPE.PROJECT,
      updated.id,
      { name: updated.name, slug: updated.slug, fields: Object.keys(input) },
    );

    return projectView(updated);
  }

  remove(context: AuthContext, projectId: string): void {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const project = requireProject(repository, projectId);

    repository.remove(projectId);
    writeConfigAudit(
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
    const project = requireProject(repository, projectId);
    let username: string | undefined;
    let token: string | undefined;

    if (project.gitCredentialId !== null) {
      const credential = requireCredential(
        new CredentialRepository(this.db, context.tenant.id).findById(project.gitCredentialId),
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

    writeConfigAudit(
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
