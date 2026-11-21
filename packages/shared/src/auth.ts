// 本文件所有改动要求遵循 agent-rules 规范

/** 租户角色，按权限从低到高排列。 */
export const TENANT_ROLES = ['viewer', 'developer', 'admin', 'owner'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const TENANT_ROLE = {
  VIEWER: 'viewer',
  DEVELOPER: 'developer',
  ADMIN: 'admin',
  OWNER: 'owner',
} as const satisfies Record<string, TenantRole>;

/** 成员与用户共用的账号状态。 */
export const USER_STATUS = {
  ACTIVE: 'active',
  INVITED: 'invited',
  SUSPENDED: 'suspended',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const MEMBER_STATUS = {
  ACTIVE: 'active',
  INVITED: 'invited',
  SUSPENDED: 'suspended',
} as const;

export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

export const TENANT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;

export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS];

/** 权限点与 PROJECT_SPEC 第 8.2 节保持一致。 */
export const PERMISSION = {
  TENANT_READ: 'tenant:read',
  TENANT_UPDATE: 'tenant:update',
  TENANT_MEMBER_MANAGE: 'tenant:member:manage',
  PROJECT_CREATE: 'project:create',
  PROJECT_READ: 'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  CREDENTIAL_READ: 'credential:read',
  CREDENTIAL_WRITE: 'credential:write',
  ENVIRONMENT_WRITE: 'environment:write',
  LLM_WRITE: 'llm:write',
  GENERATION_CREATE: 'generation:create',
  GENERATION_APPROVE: 'generation:approve',
  RUN_CREATE: 'run:create',
  RUN_CANCEL: 'run:cancel',
  REPAIR_APPROVE: 'repair:approve',
  DOC_EDIT: 'doc:edit',
  NOTIFICATION_WRITE: 'notification:write',
  AUDIT_READ: 'audit:read',
} as const;

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(Object.values(PERMISSION));

const DEVELOPER_PERMISSIONS: readonly Permission[] = Object.freeze([
  PERMISSION.TENANT_READ,
  PERMISSION.PROJECT_READ,
  PERMISSION.GENERATION_CREATE,
  PERMISSION.GENERATION_APPROVE,
  PERMISSION.RUN_CREATE,
  PERMISSION.RUN_CANCEL,
  PERMISSION.DOC_EDIT,
]);

const VIEWER_PERMISSIONS: readonly Permission[] = Object.freeze([
  PERMISSION.TENANT_READ,
  PERMISSION.PROJECT_READ,
]);

const ADMIN_PERMISSIONS: readonly Permission[] = Object.freeze(
  ALL_PERMISSIONS.filter(
    (permission) =>
      permission !== PERMISSION.TENANT_UPDATE && permission !== PERMISSION.PROJECT_DELETE,
  ),
);

/** 权限矩阵：Owner 拥有全部权限。 */
export const ROLE_PERMISSIONS: Readonly<Record<TenantRole, readonly Permission[]>> = Object.freeze({
  owner: ALL_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  developer: DEVELOPER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
});

export function permissionsForRole(role: TenantRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: TenantRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** 角色等级比较，用于「仅 OWNER 可管理 OWNER」等规则。 */
export function isRoleAtLeast(role: TenantRole, minimum: TenantRole): boolean {
  return TENANT_ROLES.indexOf(role) >= TENANT_ROLES.indexOf(minimum);
}

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

/** 审计动作常量，避免散落字符串。 */
export const AUDIT_ACTION = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGE: 'auth.password.change',
  TENANT_SWITCH: 'tenant.switch',
  TENANT_UPDATE: 'tenant.update',
  MEMBER_ADD: 'tenant.member.add',
  MEMBER_ROLE_UPDATE: 'tenant.member.role_update',
  MEMBER_REMOVE: 'tenant.member.remove',
  AUTHORIZATION_DENIED: 'authz.denied',
  PROJECT_CREATE: 'project.create',
  PROJECT_UPDATE: 'project.update',
  PROJECT_DELETE: 'project.delete',
  PROJECT_TEST_CONNECTION: 'project.test_connection',
  PROJECT_ACCESS_UPDATE: 'project.access.update',
  PROJECT_MEMBER_ADD: 'project.member.add',
  PROJECT_MEMBER_UPDATE: 'project.member.role_update',
  PROJECT_MEMBER_REMOVE: 'project.member.remove',
  CREDENTIAL_CREATE: 'credential.create',
  CREDENTIAL_UPDATE: 'credential.update',
  CREDENTIAL_DELETE: 'credential.delete',
  CREDENTIAL_TEST: 'credential.test',
  LLM_PROFILE_CREATE: 'llm_profile.create',
  LLM_PROFILE_UPDATE: 'llm_profile.update',
  LLM_PROFILE_DELETE: 'llm_profile.delete',
  LLM_PROFILE_TEST: 'llm_profile.test',
  ENVIRONMENT_CREATE: 'environment.create',
  ENVIRONMENT_UPDATE: 'environment.update',
  ENVIRONMENT_DELETE: 'environment.delete',
  ENVIRONMENT_TEST: 'environment.test',
  NOTIFICATION_CHANNEL_CREATE: 'notification_channel.create',
  NOTIFICATION_CHANNEL_UPDATE: 'notification_channel.update',
  NOTIFICATION_CHANNEL_DELETE: 'notification_channel.delete',
  NOTIFICATION_CHANNEL_TEST: 'notification_channel.test',
  GENERATION_CREATE: 'generation.create',
  GENERATION_EDIT: 'generation.edit',
  GENERATION_APPROVE: 'generation.approve',
  GENERATION_REJECT: 'generation.reject',
  GENERATION_COMMIT: 'generation.commit',
  GENERATION_FAIL: 'generation.fail',
  RUN_CREATE: 'run.create',
  RUN_CANCEL: 'run.cancel',
  RUN_FINISH: 'run.finish',
  RUN_FAIL: 'run.fail',
  REPAIR_APPROVE: 'repair.approve',
  REPAIR_REJECT: 'repair.reject',
  REPAIR_ROLLBACK: 'repair.rollback',
  DOC_SYNC: 'doc.sync',
  DOC_EDIT: 'doc.edit',
  DOC_COMPRESS: 'doc.compress',
  TRIGGER_CREATE: 'trigger.create',
  TRIGGER_UPDATE: 'trigger.update',
  TRIGGER_DELETE: 'trigger.delete',
  TRIGGER_FIRE: 'trigger.fire',
  WEBHOOK_REJECT: 'webhook.reject',
  CI_INTEGRATION_UPSERT: 'ci.integration.upsert',
  CI_INTEGRATION_DELETE: 'ci.integration.delete',
  CI_REPORT_PUBLISH: 'ci.report.publish',
  QUOTA_UPDATE: 'tenant.quota.update',
  SSO_PROVIDER_CREATE: 'sso.provider.create',
  SSO_PROVIDER_UPDATE: 'sso.provider.update',
  SSO_PROVIDER_DELETE: 'sso.provider.delete',
  SSO_LOGIN: 'sso.login',
  RUNNER_REGISTER: 'runner.register',
  RUNNER_REMOVE: 'runner.remove',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export const AUDIT_ACTIONS = [
  AUDIT_ACTION.LOGIN_SUCCESS,
  AUDIT_ACTION.LOGIN_FAILURE,
  AUDIT_ACTION.LOGOUT,
  AUDIT_ACTION.PASSWORD_CHANGE,
  AUDIT_ACTION.TENANT_SWITCH,
  AUDIT_ACTION.TENANT_UPDATE,
  AUDIT_ACTION.MEMBER_ADD,
  AUDIT_ACTION.MEMBER_ROLE_UPDATE,
  AUDIT_ACTION.MEMBER_REMOVE,
  AUDIT_ACTION.AUTHORIZATION_DENIED,
  AUDIT_ACTION.PROJECT_CREATE,
  AUDIT_ACTION.PROJECT_UPDATE,
  AUDIT_ACTION.PROJECT_DELETE,
  AUDIT_ACTION.PROJECT_TEST_CONNECTION,
  AUDIT_ACTION.PROJECT_ACCESS_UPDATE,
  AUDIT_ACTION.PROJECT_MEMBER_ADD,
  AUDIT_ACTION.PROJECT_MEMBER_UPDATE,
  AUDIT_ACTION.PROJECT_MEMBER_REMOVE,
  AUDIT_ACTION.CREDENTIAL_CREATE,
  AUDIT_ACTION.CREDENTIAL_UPDATE,
  AUDIT_ACTION.CREDENTIAL_DELETE,
  AUDIT_ACTION.CREDENTIAL_TEST,
  AUDIT_ACTION.LLM_PROFILE_CREATE,
  AUDIT_ACTION.LLM_PROFILE_UPDATE,
  AUDIT_ACTION.LLM_PROFILE_DELETE,
  AUDIT_ACTION.LLM_PROFILE_TEST,
  AUDIT_ACTION.ENVIRONMENT_CREATE,
  AUDIT_ACTION.ENVIRONMENT_UPDATE,
  AUDIT_ACTION.ENVIRONMENT_DELETE,
  AUDIT_ACTION.ENVIRONMENT_TEST,
  AUDIT_ACTION.NOTIFICATION_CHANNEL_CREATE,
  AUDIT_ACTION.NOTIFICATION_CHANNEL_UPDATE,
  AUDIT_ACTION.NOTIFICATION_CHANNEL_DELETE,
  AUDIT_ACTION.NOTIFICATION_CHANNEL_TEST,
  AUDIT_ACTION.GENERATION_CREATE,
  AUDIT_ACTION.GENERATION_EDIT,
  AUDIT_ACTION.GENERATION_APPROVE,
  AUDIT_ACTION.GENERATION_REJECT,
  AUDIT_ACTION.GENERATION_COMMIT,
  AUDIT_ACTION.GENERATION_FAIL,
  AUDIT_ACTION.RUN_CREATE,
  AUDIT_ACTION.RUN_CANCEL,
  AUDIT_ACTION.RUN_FINISH,
  AUDIT_ACTION.RUN_FAIL,
  AUDIT_ACTION.REPAIR_APPROVE,
  AUDIT_ACTION.REPAIR_REJECT,
  AUDIT_ACTION.REPAIR_ROLLBACK,
  AUDIT_ACTION.DOC_SYNC,
  AUDIT_ACTION.DOC_EDIT,
  AUDIT_ACTION.DOC_COMPRESS,
  AUDIT_ACTION.TRIGGER_CREATE,
  AUDIT_ACTION.TRIGGER_UPDATE,
  AUDIT_ACTION.TRIGGER_DELETE,
  AUDIT_ACTION.TRIGGER_FIRE,
  AUDIT_ACTION.WEBHOOK_REJECT,
  AUDIT_ACTION.CI_INTEGRATION_UPSERT,
  AUDIT_ACTION.CI_INTEGRATION_DELETE,
  AUDIT_ACTION.CI_REPORT_PUBLISH,
  AUDIT_ACTION.QUOTA_UPDATE,
  AUDIT_ACTION.SSO_PROVIDER_CREATE,
  AUDIT_ACTION.SSO_PROVIDER_UPDATE,
  AUDIT_ACTION.SSO_PROVIDER_DELETE,
  AUDIT_ACTION.SSO_LOGIN,
  AUDIT_ACTION.RUNNER_REGISTER,
  AUDIT_ACTION.RUNNER_REMOVE,
] as const satisfies readonly AuditAction[];

export const AUDIT_RESOURCE_TYPE = {
  SESSION: 'session',
  USER: 'user',
  TENANT: 'tenant',
  TENANT_MEMBER: 'tenant_member',
  PROJECT: 'project',
  CREDENTIAL: 'credential',
  LLM_PROFILE: 'llm_profile',
  ENVIRONMENT: 'environment',
  NOTIFICATION_CHANNEL: 'notification_channel',
  GENERATION: 'generation',
  FEATURE_FILE: 'feature_file',
  TEST_CASE: 'test_case',
  RUN: 'run',
  RUN_CASE: 'run_case',
  REPAIR: 'repair',
  DOC_MODULE: 'doc_module',
  TRIGGER: 'trigger',
  CI_INTEGRATION: 'ci_integration',
  SSO_PROVIDER: 'sso_provider',
  RUNNER: 'runner',
} as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPE)[keyof typeof AUDIT_RESOURCE_TYPE];

/** 会话与 CSRF Cookie 名称由前后端共享。 */
export const SESSION_COOKIE_NAME = 'gait_session';
export const CSRF_COOKIE_NAME = 'gait_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const TENANT_SLUG_MIN_LENGTH = 3;
export const TENANT_SLUG_MAX_LENGTH = 32;
export const TENANT_NAME_MAX_LENGTH = 100;
export const DISPLAY_NAME_MAX_LENGTH = 80;

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function normalizeTenantSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/** 返回密码策略违规项；空数组表示通过。 */
export function passwordPolicyIssues(password: string): string[] {
  const issues: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }

  if (password.trim().length === 0) {
    issues.push('Password must not be blank');
  }

  return issues;
}

export function usernamePolicyIssues(username: string): string[] {
  const issues: string[] = [];

  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    issues.push(`Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters long`);
  }

  if (!USERNAME_PATTERN.test(username)) {
    issues.push('Username may only contain lowercase letters, digits, dots, underscores or dashes');
  }

  return issues;
}

export function tenantSlugPolicyIssues(slug: string): string[] {
  const issues: string[] = [];

  if (slug.length < TENANT_SLUG_MIN_LENGTH || slug.length > TENANT_SLUG_MAX_LENGTH) {
    issues.push(
      `Tenant slug must be ${TENANT_SLUG_MIN_LENGTH}-${TENANT_SLUG_MAX_LENGTH} characters long`,
    );
  }

  if (!TENANT_SLUG_PATTERN.test(slug)) {
    issues.push('Tenant slug may only contain lowercase letters, digits or dashes');
  }

  return issues;
}

/** API 与 GUI 共享的身份摘要结构。 */
export interface AuthUserSummary {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isPlatformAdmin: boolean;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  role: TenantRole;
}

export interface AuthSessionSummary {
  user: AuthUserSummary;
  activeTenant: TenantSummary;
  tenants: TenantSummary[];
  permissions: readonly Permission[];
}
