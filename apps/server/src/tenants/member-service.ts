// 本文件所有改动要求遵循 agent-rules 规范
import {
  ConflictError,
  ForbiddenError,
  hashPassword,
  NotFoundError,
  nowMs,
  toIsoUtc,
  ValidationError,
} from '@gait/config';
import { AuditLogWriter, MembershipRepository, SessionRepository, UserRepository } from '@gait/db';
import type { AppDatabase, MemberWithUser } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  MEMBER_STATUS,
  normalizeUsername,
  passwordPolicyIssues,
  TENANT_ROLE,
  USER_STATUS,
  usernamePolicyIssues,
} from '@gait/shared';
import type { TenantRole } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';

export interface MemberView {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AddMemberInput {
  username: string;
  role: TenantRole;
  password?: string | undefined;
  displayName?: string | undefined;
  email?: string | undefined;
}

export interface MemberServiceOptions {
  now?: () => number;
}

function toMemberView(member: MemberWithUser): MemberView {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
    email: member.email,
    role: member.role,
    status: member.status,
    createdAt: toIsoUtc(member.createdAt),
    updatedAt: toIsoUtc(member.updatedAt),
    lastLoginAt: member.lastLoginAt === null ? null : toIsoUtc(member.lastLoginAt),
  };
}

function invalidField(field: string, messages: readonly string[]): ValidationError {
  return new ValidationError(
    'Request validation failed',
    messages.map((message) => ({ path: field, message, code: 'invalid_value' })),
  );
}

/**
 * 租户成员领域服务。
 * 安全规则：只有 OWNER 能授予/管理 OWNER；任何操作都不能移除或降级最后一个 OWNER。
 */
export class MemberService {
  private readonly now: () => number;
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly audit: AuditLogWriter;
  private readonly db: AppDatabase;

  constructor(db: AppDatabase, options: MemberServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? nowMs;
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
    this.audit = new AuditLogWriter(db);
  }

  list(context: AuthContext): MemberView[] {
    return this.members(context).list().map(toMemberView);
  }

  async addMember(context: AuthContext, input: AddMemberInput): Promise<MemberView> {
    const username = normalizeUsername(input.username);
    const usernameIssues = usernamePolicyIssues(username);

    if (usernameIssues.length > 0) {
      throw invalidField('username', usernameIssues);
    }

    if (input.role === TENANT_ROLE.OWNER && context.role !== TENANT_ROLE.OWNER) {
      throw new ForbiddenError('Only an owner can assign the owner role');
    }

    const members = this.members(context);
    const now = this.now();
    let user = this.users.findByUsername(username);
    let createdUser = false;

    if (user === undefined) {
      if (input.password === undefined) {
        throw invalidField('password', ['Password is required for a new user']);
      }

      const passwordIssues = passwordPolicyIssues(input.password);

      if (passwordIssues.length > 0) {
        throw invalidField('password', passwordIssues);
      }

      const email = input.email?.trim().toLowerCase() ?? null;

      if (email !== null && this.users.findByEmail(email) !== undefined) {
        throw new ConflictError('Email is already in use');
      }

      user = this.users.create({
        username,
        email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName?.trim() || username,
        now,
      });
      createdUser = true;
    } else if (user.status !== USER_STATUS.ACTIVE) {
      throw new ConflictError('User account is not active');
    }

    if (members.find(user.id) !== undefined) {
      throw new ConflictError('User is already a member of this tenant');
    }

    members.add({ userId: user.id, role: input.role, now });
    this.audit.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.MEMBER_ADD,
      resourceType: AUDIT_RESOURCE_TYPE.TENANT_MEMBER,
      resourceId: `${context.tenant.id}:${user.id}`,
      detail: { username, role: input.role, createdUser },
      now,
    });

    const member = members.find(user.id);

    if (member === undefined) {
      throw new NotFoundError('Member not found');
    }

    return toMemberView(member);
  }

  updateRole(context: AuthContext, userId: string, role: TenantRole): MemberView {
    const members = this.members(context);
    const target = members.find(userId);

    if (target === undefined) {
      throw new NotFoundError('Member not found');
    }

    if (target.role === role) {
      return toMemberView(target);
    }

    if (
      (target.role === TENANT_ROLE.OWNER || role === TENANT_ROLE.OWNER) &&
      context.role !== TENANT_ROLE.OWNER
    ) {
      throw new ForbiddenError('Only an owner can manage the owner role');
    }

    if (
      target.role === TENANT_ROLE.OWNER &&
      target.status === MEMBER_STATUS.ACTIVE &&
      members.countActiveOwners() <= 1
    ) {
      throw new ConflictError('Tenant must have at least one active owner');
    }

    const now = this.now();
    members.updateRole(userId, role, now);
    this.audit.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.MEMBER_ROLE_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TENANT_MEMBER,
      resourceId: `${context.tenant.id}:${userId}`,
      detail: { username: target.username, fromRole: target.role, toRole: role },
      now,
    });

    const updated = members.find(userId);

    if (updated === undefined) {
      throw new NotFoundError('Member not found');
    }

    return toMemberView(updated);
  }

  removeMember(context: AuthContext, userId: string): void {
    const members = this.members(context);
    const target = members.find(userId);

    if (target === undefined) {
      throw new NotFoundError('Member not found');
    }

    if (target.role === TENANT_ROLE.OWNER && context.role !== TENANT_ROLE.OWNER) {
      throw new ForbiddenError('Only an owner can remove an owner');
    }

    if (
      target.role === TENANT_ROLE.OWNER &&
      target.status === MEMBER_STATUS.ACTIVE &&
      members.countActiveOwners() <= 1
    ) {
      throw new ConflictError('Tenant must have at least one active owner');
    }

    const now = this.now();
    members.remove(userId);
    this.sessions.revokeForUserInTenant(userId, context.tenant.id, now);
    this.audit.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.MEMBER_REMOVE,
      resourceType: AUDIT_RESOURCE_TYPE.TENANT_MEMBER,
      resourceId: `${context.tenant.id}:${userId}`,
      detail: { username: target.username, role: target.role },
      now,
    });
  }

  private members(context: AuthContext): MembershipRepository {
    return new MembershipRepository(this.db, context.tenant.id);
  }
}
