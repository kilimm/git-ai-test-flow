// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  isRoleAtLeast,
  normalizeTenantSlug,
  normalizeUsername,
  passwordPolicyIssues,
  PERMISSION,
  permissionsForRole,
  roleHasPermission,
  TENANT_ROLES,
  tenantSlugPolicyIssues,
  usernamePolicyIssues,
} from '../src/auth.js';

describe('RBAC matrix', () => {
  it('grants the spec permissions to each role', () => {
    expect(permissionsForRole('owner')).toHaveLength(19);
    expect(roleHasPermission('owner', PERMISSION.TENANT_UPDATE)).toBe(true);
    expect(roleHasPermission('owner', PERMISSION.PROJECT_DELETE)).toBe(true);

    expect(roleHasPermission('admin', PERMISSION.AUDIT_READ)).toBe(true);
    expect(roleHasPermission('admin', PERMISSION.CREDENTIAL_WRITE)).toBe(true);
    expect(roleHasPermission('admin', PERMISSION.TENANT_UPDATE)).toBe(false);
    expect(roleHasPermission('admin', PERMISSION.PROJECT_DELETE)).toBe(false);

    expect(roleHasPermission('developer', PERMISSION.GENERATION_CREATE)).toBe(true);
    expect(roleHasPermission('developer', PERMISSION.RUN_CREATE)).toBe(true);
    expect(roleHasPermission('developer', PERMISSION.CREDENTIAL_READ)).toBe(false);
    expect(roleHasPermission('developer', PERMISSION.AUDIT_READ)).toBe(false);

    expect(permissionsForRole('viewer')).toEqual([PERMISSION.TENANT_READ, PERMISSION.PROJECT_READ]);
  });

  it('compares role levels', () => {
    expect(isRoleAtLeast('owner', 'admin')).toBe(true);
    expect(isRoleAtLeast('admin', 'owner')).toBe(false);
    expect(isRoleAtLeast('viewer', 'viewer')).toBe(true);
    expect(TENANT_ROLES).toHaveLength(4);
  });

  it('keeps audit action constants unique and complete', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toContain('auth.login.failure');
    expect(AUDIT_ACTIONS).toContain('tenant.member.remove');
  });
});

describe('identity policy helpers', () => {
  it('normalizes usernames and tenant slugs', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(normalizeTenantSlug(' ACME ')).toBe('acme');
  });

  it('validates usernames', () => {
    expect(usernamePolicyIssues('alice')).toEqual([]);
    expect(usernamePolicyIssues('alice.smith-1')).toEqual([]);
    expect(usernamePolicyIssues('Al')).not.toEqual([]);
    expect(usernamePolicyIssues('Alice')).not.toEqual([]);
    expect(usernamePolicyIssues('bad name')).not.toEqual([]);
    expect(usernamePolicyIssues('a'.repeat(33))).not.toEqual([]);
  });

  it('validates tenant slugs and passwords', () => {
    expect(tenantSlugPolicyIssues('acme-team')).toEqual([]);
    expect(tenantSlugPolicyIssues('A')).not.toEqual([]);
    expect(tenantSlugPolicyIssues('bad_slug')).not.toEqual([]);
    expect(tenantSlugPolicyIssues('a'.repeat(33))).not.toEqual([]);

    expect(passwordPolicyIssues('correct horse battery')).toEqual([]);
    expect(passwordPolicyIssues('short')).not.toEqual([]);
    expect(passwordPolicyIssues(' '.repeat(16))).not.toEqual([]);
    expect(passwordPolicyIssues('a'.repeat(129))).not.toEqual([]);
  });
});
