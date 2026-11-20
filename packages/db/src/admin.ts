// 本文件所有改动要求遵循 agent-rules 规范
import { ConflictError, hashPassword, nowMs, ValidationError } from '@gait/config';
import {
  normalizeTenantSlug,
  normalizeUsername,
  passwordPolicyIssues,
  TENANT_ROLE,
  tenantSlugPolicyIssues,
  usernamePolicyIssues,
} from '@gait/shared';
import type { AppDatabase } from './client.js';
import { MembershipRepository } from './repositories/membership-repository.js';
import { TenantRepository } from './repositories/tenant-repository.js';
import { UserRepository } from './repositories/user-repository.js';
import type { Tenant, TenantMember, User } from './schema.js';

export const DEFAULT_ADMIN_TENANT_SLUG = 'default';
export const DEFAULT_ADMIN_TENANT_NAME = 'Default Workspace';

export interface CreatePlatformAdminInput {
  username: string;
  password: string;
  tenantSlug?: string;
  tenantName?: string;
  displayName?: string;
  email?: string;
  now?: number;
}

export interface CreatePlatformAdminResult {
  user: User;
  tenant: Tenant;
  membership: TenantMember;
}

function policyError(field: string, issues: readonly string[]): ValidationError {
  return new ValidationError(
    'Invalid administrator input',
    issues.map((message) => ({ path: field, message, code: 'invalid_value' })),
  );
}

/**
 * 创建首个平台管理员，同时创建（或复用）租户并授予 OWNER。
 * 已存在平台管理员或用户名被占用时拒绝，避免绕过 CLI 的匿名注册。
 */
export async function createPlatformAdmin(
  db: AppDatabase,
  input: CreatePlatformAdminInput,
): Promise<CreatePlatformAdminResult> {
  const username = normalizeUsername(input.username);
  const usernameIssues = usernamePolicyIssues(username);

  if (usernameIssues.length > 0) {
    throw policyError('username', usernameIssues);
  }

  const passwordIssues = passwordPolicyIssues(input.password);

  if (passwordIssues.length > 0) {
    throw policyError('password', passwordIssues);
  }

  const tenantSlug = normalizeTenantSlug(input.tenantSlug ?? DEFAULT_ADMIN_TENANT_SLUG);
  const tenantSlugIssues = tenantSlugPolicyIssues(tenantSlug);

  if (tenantSlugIssues.length > 0) {
    throw policyError('tenantSlug', tenantSlugIssues);
  }

  const users = new UserRepository(db);
  const tenants = new TenantRepository(db);

  if (users.countPlatformAdmins() > 0) {
    throw new ConflictError('A platform administrator already exists');
  }

  if (users.findByUsername(username) !== undefined) {
    throw new ConflictError('Username is already in use');
  }

  const email = input.email?.trim().toLowerCase() ?? null;

  if (email !== null && email.length > 0 && users.findByEmail(email) !== undefined) {
    throw new ConflictError('Email is already in use');
  }

  const passwordHash = await hashPassword(input.password);
  const now = input.now ?? nowMs();
  const tenant =
    tenants.findBySlug(tenantSlug) ??
    tenants.create({
      slug: tenantSlug,
      name: input.tenantName?.trim() || DEFAULT_ADMIN_TENANT_NAME,
      now,
    });
  const user = users.create({
    username,
    email: email === '' ? null : email,
    passwordHash,
    displayName: input.displayName?.trim() || username,
    isPlatformAdmin: true,
    now,
  });
  const membership = new MembershipRepository(db, tenant.id).add({
    userId: user.id,
    role: TENANT_ROLE.OWNER,
    now,
  });

  return { user, tenant, membership };
}
