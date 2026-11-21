// 本文件所有改动要求遵循 agent-rules 规范

/** 项目级角色只用于限制访问，不扩大租户角色已有的权限。 */
export const PROJECT_ROLES = ['viewer', 'developer', 'admin'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_ROLE = {
  VIEWER: 'viewer',
  DEVELOPER: 'developer',
  ADMIN: 'admin',
} as const satisfies Record<string, ProjectRole>;

export const PROJECT_ACCESS_MODES = ['tenant', 'restricted'] as const;
export type ProjectAccessMode = (typeof PROJECT_ACCESS_MODES)[number];

export const PROJECT_ACCESS_MODE = {
  TENANT: 'tenant',
  RESTRICTED: 'restricted',
} as const satisfies Record<string, ProjectAccessMode>;

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function projectRoleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(minimum);
}

/** 受限项目按路径与请求方法推断最低角色。 */
export function minimumProjectRole(method: string, path: string): ProjectRole {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return PROJECT_ROLE.VIEWER;
  }

  if (
    /\/members(\/|$)/.test(path) ||
    /\/access$/.test(path) ||
    (/^\/api\/v1\/projects\/[^/]+$/.test(path) && (method === 'PATCH' || method === 'DELETE'))
  ) {
    return PROJECT_ROLE.ADMIN;
  }

  return PROJECT_ROLE.DEVELOPER;
}
