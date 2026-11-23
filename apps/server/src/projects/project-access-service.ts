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

const NOTIFICATIONS_PATH = '/api/v1/notifications';

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

  async effectiveRole(context: AuthContext, project: Project): Promise<ProjectRole | null> {
    if (context.role === 'owner' || context.role === 'admin') {
      return PROJECT_ROLE.ADMIN;
    }

    if (this.accessModeOf(project) === PROJECT_ACCESS_MODE.TENANT) {
      return context.role === 'developer' ? PROJECT_ROLE.DEVELOPER : PROJECT_ROLE.VIEWER;
    }

    const membership = await new ProjectMemberRepository(this.db, context.tenant.id).find(
      project.id,
      context.user.id,
    );

    return membership?.role ?? null;
  }

  async canView(context: AuthContext, project: Project): Promise<boolean> {
    return (await this.effectiveRole(context, project)) !== null;
  }

  async requireView(context: AuthContext, project: Project): Promise<ProjectRole> {
    const role = await this.effectiveRole(context, project);

    if (role === null) {
      throw new NotFoundError('Project not found');
    }

    return role;
  }

  async requireRole(
    context: AuthContext,
    project: Project,
    minimum: ProjectRole,
  ): Promise<ProjectRole> {
    const role = await this.requireView(context, project);

    if (!projectRoleAtLeast(role, minimum)) {
      throw new ForbiddenError('Project role does not permit this operation');
    }

    return role;
  }

  async listProjects(context: AuthContext): Promise<Project[]> {
    const projects = await new ProjectRepository(this.db, context.tenant.id).list();
    const visible: Project[] = [];

    for (const project of projects) {
      if (await this.canView(context, project)) {
        visible.push(project);
      }
    }

    return visible;
  }

  async view(context: AuthContext, projectId: string): Promise<ProjectAccessView> {
    const project = await new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    const role = await this.requireView(context, project);
    const members = await new ProjectMemberRepository(this.db, context.tenant.id).listByProject(
      project.id,
    );
    const users = new UserRepository(this.db);
    const memberViews: ProjectMemberView[] = [];

    for (const member of members) {
      const user = await users.findById(member.userId);

      memberViews.push({
        userId: member.userId,
        username: user?.username ?? member.userId,
        displayName: user?.displayName ?? member.userId,
        role: member.role,
        createdAt: new Date(member.createdAt).toISOString(),
      });
    }

    return {
      projectId: project.id,
      accessMode: this.accessModeOf(project),
      effectiveRole: role,
      canManage: projectRoleAtLeast(role, PROJECT_ROLE.ADMIN),
      members: memberViews,
    };
  }

  async updateAccessMode(
    context: AuthContext,
    projectId: string,
    accessMode: ProjectAccessMode,
  ): Promise<ProjectAccessView> {
    const repository = new ProjectRepository(this.db, context.tenant.id);
    const project = await repository.findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    await this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    await repository.update(project.id, { accessMode });

    return this.view(context, project.id);
  }

  async addMember(
    context: AuthContext,
    projectId: string,
    username: string,
    role: ProjectRole,
  ): Promise<ProjectAccessView> {
    const projectRepository = new ProjectRepository(this.db, context.tenant.id);
    const project = await projectRepository.findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    await this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    const user = await new UserRepository(this.db).findByUsername(username);

    if (user === undefined) {
      throw new ValidationError('User not found');
    }

    const membership = await new MembershipRepository(this.db, context.tenant.id).find(user.id);

    if (membership === undefined) {
      throw new ValidationError('User is not a member of this tenant');
    }

    await new ProjectMemberRepository(this.db, context.tenant.id).upsert({
      projectId: project.id,
      userId: user.id,
      role,
    });

    return this.view(context, project.id);
  }

  async updateMember(
    context: AuthContext,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectAccessView> {
    const project = await new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    await this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    const repository = new ProjectMemberRepository(this.db, context.tenant.id);

    if ((await repository.find(project.id, userId)) === undefined) {
      throw new NotFoundError('Project member not found');
    }

    await repository.upsert({ projectId: project.id, userId, role });

    return this.view(context, project.id);
  }

  async removeMember(
    context: AuthContext,
    projectId: string,
    userId: string,
  ): Promise<ProjectAccessView> {
    const project = await new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    await this.requireRole(context, project, PROJECT_ROLE.ADMIN);
    await new ProjectMemberRepository(this.db, context.tenant.id).remove(project.id, userId);

    return this.view(context, project.id);
  }

  /** 在认证守卫之后调用：解析请求关联项目并校验最低项目角色。 */
  async assertRequestAccess(
    context: AuthContext,
    requestUrl: string,
    _params: unknown,
    method: string,
  ): Promise<void> {
    const [path = requestUrl, queryString = ''] = requestUrl.split('?');

    if (path === NOTIFICATIONS_PATH) {
      await this.assertNotificationsAccess(context, new URLSearchParams(queryString), path, method);

      return;
    }

    const directProjectId = routeProjectId(path);

    if (directProjectId !== null) {
      await this.assertProjectIdAccess(context, directProjectId, path, method);

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

    const projectId = await this.projectIdForResource(
      context,
      path,
      decodeURIComponent(resourceId),
    );

    if (projectId !== null) {
      await this.assertProjectIdAccess(context, projectId, path, method);
    }
  }

  /**
   * /notifications 通过 query 指定 runId 或 projectId，必须按资源反查项目后校验，
   * 否则 restricted 项目的成员可以借查询参数读取通知。
   */
  private async assertNotificationsAccess(
    context: AuthContext,
    query: URLSearchParams,
    path: string,
    method: string,
  ): Promise<void> {
    const projectId = query.get('projectId');

    if (projectId !== null && projectId.length > 0) {
      await this.assertProjectIdAccess(context, projectId, path, method);
    }

    const runId = query.get('runId');

    if (runId !== null && runId.length > 0) {
      const run = await new RunRepository(this.db, context.tenant.id).findById(runId);

      if (run !== undefined) {
        await this.assertProjectIdAccess(context, run.projectId, path, method);
      }
    }
  }

  async assertProjectIdAccess(
    context: AuthContext,
    projectId: string,
    requestPath: string,
    method: string,
  ): Promise<void> {
    const project = await new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    if (this.accessModeOf(project) === PROJECT_ACCESS_MODE.TENANT) {
      return;
    }

    await this.requireRole(context, project, minimumProjectRole(method, requestPath));
  }

  /**
   * 对非 /projects/:id 的资源路径，按资源反查项目。只覆盖项目敏感资源；
   * 租户级凭据保持租户 RBAC。
   */
  async projectIdForResource(
    context: AuthContext,
    path: string,
    id: string,
  ): Promise<string | null> {
    const tenantId = context.tenant.id;

    if (/^\/api\/v1\/generations\/[^/]+/.test(path)) {
      const generation = await new GenerationRepository(this.db, tenantId).findById(id);

      return generation?.projectId ?? null;
    }

    if (/^\/api\/v1\/runs\/[^/]+/.test(path)) {
      const run = await new RunRepository(this.db, tenantId).findById(id);

      return run?.projectId ?? null;
    }

    if (/^\/api\/v1\/run-cases\/[^/]+/.test(path)) {
      const runCase = await new RunCaseRepository(this.db, tenantId).findById(id);
      const run =
        runCase === undefined
          ? undefined
          : await new RunRepository(this.db, tenantId).findById(runCase.runId);

      return run?.projectId ?? null;
    }

    if (/^\/api\/v1\/environments\/[^/]+/.test(path)) {
      const environment = await new EnvironmentRepository(this.db, tenantId).findById(id);

      return environment?.projectId ?? null;
    }

    if (/^\/api\/v1\/llm-profiles\/[^/]+/.test(path)) {
      const profile = await new LlmProfileRepository(this.db, tenantId).findById(id);

      return profile?.projectId ?? null;
    }

    if (/^\/api\/v1\/notification-channels\/[^/]+/.test(path)) {
      const channel = await new NotificationChannelRepository(this.db, tenantId).findById(id);

      return channel?.projectId ?? null;
    }

    if (/^\/api\/v1\/doc-modules\/[^/]+/.test(path)) {
      const docModule = await new DocRepository(this.db, tenantId).findModuleById(id);

      return docModule?.projectId ?? null;
    }

    return null;
  }
}
