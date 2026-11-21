// 本文件所有改动要求遵循 agent-rules 规范
import { ForbiddenError, NotFoundError, ValidationError } from '@gait/config';
import {
  DocRepository,
  EnvironmentRepository,
  GenerationRepository,
  LlmProfileRepository,
  MembershipRepository,
  NotificationChannelRepository,
  ProjectMemberRepository,
  ProjectRepository,
  RunCaseRepository,
  RunRepository,
  UserRepository,
} from '@gait/db';
import type { AppDatabase, Project } from '@gait/db';
import {
  PROJECT_ACCESS_MODE,
  PROJECT_ROLE,
  minimumProjectRole,
  projectRoleAtLeast,
} from '@gait/shared';
import type { ProjectAccessMode, ProjectRole } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';

export interface ProjectMemberView {
  userId: string;
  username: string;
  displayName: string;
  role: ProjectRole;
  createdAt: string;
}

export interface ProjectAccessView {
  projectId: string;
  accessMode: ProjectAccessMode;
  effectiveRole: ProjectRole | null;
  canManage: boolean;
  members: ProjectMemberView[];
}

function routeProjectId(path: string): string | null {
  const explicit = /^\/api\/v1\/projects\/([^/]+)/.exec(path);

  return explicit?.[1] === undefined ? null : decodeURIComponent(explicit[1]);
}

/**
 * 项目级访问控制：
 * - tenant 模式保持 M7 行为（租户成员按租户 RBAC 访问）；
 * - restricted 模式只允许 OWNER/ADMIN 或项目成员访问；
 * - 项目成员只限制、不提升租户权限；业务权限仍由租户 RBAC 决定；
 * - 非成员访问 restricted 项目统一 404，避免泄漏项目存在性。
 */
export class ProjectAccessService {
  constructor(private readonly db: AppDatabase) {}

  accessModeOf(project: Project): ProjectAccessMode {
    return project.accessMode === PROJECT_ACCESS_MODE.RESTRICTED
      ? PROJECT_ACCESS_MODE.RESTRICTED
      : PROJECT_ACCESS_MODE.TENANT;
  }

  effectiveRole(context: AuthContext, project: Project): ProjectRole | null {
    if (context.role === 'owner' || context.role === 'admin') {
      return PROJECT_ROLE.ADMIN;
    }

    if (this.accessModeOf(project) === PROJECT_ACCESS_MODE.TENANT) {
      return context.role === 'developer' ? PROJECT_ROLE.DEVELOPER : PROJECT_ROLE.VIEWER;
    }

    return (
      new ProjectMemberRepository(this.db, context.tenant.id).find(project.id, context.user.id)
        ?.role ?? null
    );
  }

  canView(context: AuthContext, project: Project): boolean {
    return this.effectiveRole(context, project) !== null;
  }

  requireView(context: AuthContext, project: Project): ProjectRole {
    const role = this.effectiveRole(context, project);

    if (role === null) {
      throw new NotFoundError('Project not found');
    }

    return role;
  }

  requireRole(context: AuthContext, project: Project, minimum: ProjectRole): ProjectRole {
    const role = this.requireView(context, project);

    if (!projectRoleAtLeast(role, minimum)) {
      throw new ForbiddenError('Project role does not permit this operation');
    }

    return role;
  }

  listProjects(context: AuthContext): Project[] {
    const projects = new ProjectRepository(this.db, context.tenant.id).list();

    return projects.filter((project) => this.canView(context, project));
  }

  view(context: AuthContext, projectId: string): ProjectAccessView {
    const project = new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    const role = this.requireView(context, project);
    const members = new ProjectMemberRepository(this.db, context.tenant.id).listByProject(
      project.id,
    );
    const users = new UserRepository(this.db);

    return {
      projectId: project.id,
      accessMode: this.accessModeOf(project),
      effectiveRole: role,
      canManage: projectRoleAtLeast(role, PROJECT_ROLE.ADMIN),
      members: members.map((member) => {
        const user = users.findById(member.userId);

        return {
          userId: member.userId,
          username: user?.username ?? member.userId,
          displayName: user?.displayName ?? member.userId,
          role: member.role,
          createdAt: new Date(member.createdAt).toISOString(),
        };
      }),
    };
  }

  updateAccessMode(
    context: AuthContext,
    projectId: string,
    accessMode: ProjectAccessMode,
  ): ProjectAccessView {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const project = repository.findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    repository.update(project.id, { accessMode });

    return this.view(context, project.id);
  }

  addMember(
    context: AuthContext,
    projectId: string,
    username: string,
    role: ProjectRole,
  ): ProjectAccessView {
    const projectRepository = new ProjectRepository(this.db, context.tenant.id);
    const project = projectRepository.findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    const user = new UserRepository(this.db).findByUsername(username);

    if (user === undefined) {
      throw new ValidationError('User not found');
    }

    const membership = new MembershipRepository(this.db, context.tenant.id).find(user.id);

    if (membership === undefined) {
      throw new ValidationError('User is not a member of this tenant');
    }

    new ProjectMemberRepository(this.db, context.tenant.id).upsert({
      projectId: project.id,
      userId: user.id,
      role,
    });

    return this.view(context, project.id);
  }

  updateMember(
    context: AuthContext,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): ProjectAccessView {
    const project = new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    const repository = new ProjectMemberRepository(this.db, context.tenant.id);

    if (repository.find(project.id, userId) === undefined) {
      throw new NotFoundError('Project member not found');
    }

    repository.upsert({ projectId: project.id, userId, role });

    return this.view(context, project.id);
  }

  removeMember(context: AuthContext, projectId: string, userId: string): ProjectAccessView {
    const project = new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    new ProjectMemberRepository(this.db, context.tenant.id).remove(project.id, userId);

    return this.view(context, project.id);
  }

  /** 在认证守卫之后调用：解析请求关联项目并校验最低项目角色。 */
  assertRequestAccess(
    context: AuthContext,
    requestUrl: string,
    _params: unknown,
    method: string,
  ): void {
    const path = requestUrl.split('?')[0] ?? requestUrl;
    const directProjectId = routeProjectId(path);

    if (directProjectId !== null) {
      this.assertProjectIdAccess(context, directProjectId, path, method);

      return;
    }

    const resource =
      /^\/api\/v1\/(generations|runs|run-cases|environments|llm-profiles|notification-channels|doc-modules)\/([^/]+)/.exec(
        path,
      );
    const resourceId = resource?.[2];

    if (resourceId === undefined) {
      return;
    }

    const projectId = this.projectIdForResource(context, path, decodeURIComponent(resourceId));

    if (projectId !== null) {
      this.assertProjectIdAccess(context, projectId, path, method);
    }
  }

  assertProjectIdAccess(
    context: AuthContext,
    projectId: string,
    requestPath: string,
    method: string,
  ): void {
    const project = new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    if (this.accessModeOf(project) === PROJECT_ACCESS_MODE.TENANT) {
      return;
    }

    this.requireRole(context, project, minimumProjectRole(method, requestPath));
  }

  /**
   * 对非 /projects/:id 的资源路径，按资源反查项目。只覆盖项目敏感资源；
   * 租户级凭据保持租户 RBAC。
   */
  projectIdForResource(context: AuthContext, path: string, id: string): string | null {
    const tenantId = context.tenant.id;

    if (/^\/api\/v1\/generations\/[^/]+/.test(path)) {
      return new GenerationRepository(this.db, tenantId).findById(id)?.projectId ?? null;
    }

    if (/^\/api\/v1\/runs\/[^/]+/.test(path)) {
      return new RunRepository(this.db, tenantId).findById(id)?.projectId ?? null;
    }

    if (/^\/api\/v1\/run-cases\/[^/]+/.test(path)) {
      const runCase = new RunCaseRepository(this.db, tenantId).findById(id);
      const run =
        runCase === undefined
          ? undefined
          : new RunRepository(this.db, tenantId).findById(runCase.runId);

      return run?.projectId ?? null;
    }

    if (/^\/api\/v1\/environments\/[^/]+/.test(path)) {
      return new EnvironmentRepository(this.db, tenantId).findById(id)?.projectId ?? null;
    }

    if (/^\/api\/v1\/llm-profiles\/[^/]+/.test(path)) {
      return new LlmProfileRepository(this.db, tenantId).findById(id)?.projectId ?? null;
    }

    if (/^\/api\/v1\/notification-channels\/[^/]+/.test(path)) {
      return new NotificationChannelRepository(this.db, tenantId).findById(id)?.projectId ?? null;
    }

    if (/^\/api\/v1\/doc-modules\/[^/]+/.test(path)) {
      return new DocRepository(this.db, tenantId).findModuleById(id)?.projectId ?? null;
    }

    return null;
  }
}
