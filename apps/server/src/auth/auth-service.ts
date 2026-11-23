// 本文件所有改动要求遵循 agent-rules 规范
import {
  hashPassword,
  InvalidCredentialsError,
  NotFoundError,
  nowMs,
  RateLimitError,
  ValidationError,
  verifyPassword,
} from '@gait/config';
import {
  AuditLogWriter,
  MembershipAccessRepository,
  SessionRepository,
  UserRepository,
} from '@gait/db';
import type { AppDatabase, Session, Tenant, TenantAccess, User } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  normalizeUsername,
  passwordPolicyIssues,
  permissionsForRole,
  USER_STATUS,
} from '@gait/shared';
import type {
  AuthSessionSummary,
  AuthUserSummary,
  Permission,
  TenantRole,
  TenantSummary,
} from '@gait/shared';
import { LoginRateLimiter } from './login-rate-limiter.js';
import {
  createSessionToken,
  hashSessionToken,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './session-token.js';

const DUMMY_PASSWORD = 'dummy-password-for-login-timing';

let dummyHashPromise: Promise<string> | undefined;

/** 用户不存在时也执行一次同成本的哈希校验，降低用户名枚举的时序差异。 */
async function verifyWithDummyHash(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword(DUMMY_PASSWORD);

  try {
    await verifyPassword(await dummyHashPromise, password);
  } catch {
    dummyHashPromise = undefined;
  }
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface LoginInput extends RequestMeta {
  username: string;
  password: string;
  existingToken?: string | null;
}

export interface LoginResult {
  token: string;
  user: User;
  session: Session;
  activeTenant: TenantAccess;
  tenants: TenantAccess[];
}

export interface AuthContext {
  user: User;
  session: Session;
  tenant: Tenant;
  role: TenantRole;
  permissions: readonly Permission[];
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface SwitchTenantResult {
  activeTenant: TenantSummary;
  tenants: TenantSummary[];
  permissions: readonly Permission[];
}

export interface AuthServiceOptions {
  now?: () => number;
  rateLimiter?: LoginRateLimiter;
}

export function toAuthUserSummary(user: User): AuthUserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

export function toTenantSummary(access: TenantAccess): TenantSummary {
  return {
    id: access.tenant.id,
    slug: access.tenant.slug,
    name: access.tenant.name,
    role: access.role,
  };
}

function truncate(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) {
    return null;
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * 认证领域服务：登录、会话校验、改密、租户切换。
 * tenant_id 始终来自会话与成员关系，从不读取请求参数。
 */
export class AuthService {
  private readonly now: () => number;
  private readonly rateLimiter: LoginRateLimiter;
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly access: MembershipAccessRepository;
  private readonly audit: AuditLogWriter;

  constructor(db: AppDatabase, options: AuthServiceOptions = {}) {
    this.now = options.now ?? nowMs;
    this.rateLimiter = options.rateLimiter ?? new LoginRateLimiter({ now: () => this.now() });
    this.users = new UserRepository(db);
    this.sessions = new SessionRepository(db);
    this.access = new MembershipAccessRepository(db);
    this.audit = new AuditLogWriter(db);
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const now = this.now();
    const username = normalizeUsername(input.username);
    const ip = input.ip ?? 'unknown';
    const user = await this.users.findByUsername(username);

    if (!this.rateLimiter.check(ip, username).allowed) {
      await this.writeLoginFailure(user ?? null, username, input, 'rate_limited');
      throw new RateLimitError('Too many login attempts, try again later');
    }

    if (user === undefined) {
      this.rateLimiter.recordFailure(ip, username);
      await verifyWithDummyHash(input.password);
      await this.writeLoginFailure(null, username, input, 'invalid_credentials');
      throw new InvalidCredentialsError();
    }

    const passwordMatches = await verifyPassword(user.passwordHash, input.password);

    if (!passwordMatches) {
      this.rateLimiter.recordFailure(ip, username);
      await this.writeLoginFailure(user, username, input, 'invalid_credentials');
      throw new InvalidCredentialsError();
    }

    if (user.status !== USER_STATUS.ACTIVE) {
      await this.writeLoginFailure(user, username, input, 'user_inactive');
      throw new InvalidCredentialsError('Account is not available');
    }

    const tenants = await this.access.listActiveForUser(user.id);
    const activeTenant = tenants[0];

    if (activeTenant === undefined) {
      await this.writeLoginFailure(user, username, input, 'no_active_tenant');
      throw new InvalidCredentialsError('Account has no active tenant');
    }

    if (input.existingToken !== null && input.existingToken !== undefined) {
      await this.sessions.revokeByTokenHash(hashSessionToken(input.existingToken), now);
    }

    const { token, tokenHash } = createSessionToken();
    const session = await this.sessions.create({
      userId: user.id,
      tenantId: activeTenant.tenant.id,
      tokenHash,
      expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
      lastSeenAt: now,
      ip: input.ip,
      userAgent: truncate(input.userAgent ?? undefined, 512),
      now,
    });

    await this.users.recordLogin(user.id, now);
    this.rateLimiter.reset(ip, username);
    await this.audit.append({
      tenantId: activeTenant.tenant.id,
      actorUserId: user.id,
      action: AUDIT_ACTION.LOGIN_SUCCESS,
      resourceType: AUDIT_RESOURCE_TYPE.SESSION,
      resourceId: session.id,
      ip: input.ip,
      userAgent: truncate(input.userAgent ?? undefined, 512),
      detail: { username: user.username },
      now,
    });

    return { token, user, session, activeTenant, tenants };
  }

  /**
   * SSO 回调使用：用户已由可信 OIDC 流程认证，这里只创建平台会话。
   * 不做密码校验，但仍校验目标租户的活动成员关系。
   */
  async createSessionForUser(
    user: User,
    tenantId: string,
    meta: RequestMeta & { existingToken?: string | null; provider?: string },
  ): Promise<LoginResult> {
    const now = this.now();
    const tenants = await this.access.listActiveForUser(user.id);
    const activeTenant = tenants.find((item) => item.tenant.id === tenantId);

    if (activeTenant === undefined) {
      throw new InvalidCredentialsError('Account has no active membership in this tenant');
    }

    if (meta.existingToken !== null && meta.existingToken !== undefined) {
      await this.sessions.revokeByTokenHash(hashSessionToken(meta.existingToken), now);
    }

    const { token, tokenHash } = createSessionToken();
    const session = await this.sessions.create({
      userId: user.id,
      tenantId: activeTenant.tenant.id,
      tokenHash,
      expiresAt: now + SESSION_ABSOLUTE_TTL_MS,
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: truncate(meta.userAgent ?? undefined, 512),
      now,
    });

    await this.users.recordLogin(user.id, now);
    await this.audit.append({
      tenantId: activeTenant.tenant.id,
      actorUserId: user.id,
      action: AUDIT_ACTION.LOGIN_SUCCESS,
      resourceType: AUDIT_RESOURCE_TYPE.SESSION,
      resourceId: session.id,
      ip: meta.ip,
      userAgent: truncate(meta.userAgent ?? undefined, 512),
      detail: { username: user.username, method: 'sso', provider: meta.provider ?? null },
      now,
    });

    return { token, user, session, activeTenant, tenants };
  }

  /**
   * 解析 Cookie token 并返回认证上下文；过期、撤销、成员失效的会话都返回 undefined。
   * 会话活动时间按分钟级节流写回，避免每个请求都写库。
   */
  async authenticate(token: string | undefined): Promise<AuthContext | undefined> {
    if (token === undefined) {
      return undefined;
    }

    const now = this.now();
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));

    if (session === undefined || session.revokedAt !== null) {
      return undefined;
    }

    if (now >= session.expiresAt || now - session.lastSeenAt >= SESSION_IDLE_TTL_MS) {
      await this.sessions.revoke(session.id, now);
      return undefined;
    }

    const user = await this.users.findById(session.userId);

    if (user === undefined || user.status !== USER_STATUS.ACTIVE) {
      await this.sessions.revoke(session.id, now);
      return undefined;
    }

    if (session.tenantId === null) {
      await this.sessions.revoke(session.id, now);
      return undefined;
    }

    const access = await this.access.findActiveForUser(user.id, session.tenantId);

    if (access === undefined) {
      await this.sessions.revoke(session.id, now);
      return undefined;
    }

    if (now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      await this.sessions.touchLastSeen(session.id, now);
    }

    return {
      user,
      session,
      tenant: access.tenant,
      role: access.role,
      permissions: permissionsForRole(access.role),
    };
  }

  /** 退出登录是幂等操作：无效或已撤销的 token 也返回成功。 */
  async logout(token: string | undefined, meta: RequestMeta): Promise<void> {
    if (token === undefined) {
      return;
    }

    const now = this.now();
    const session = await this.sessions.findByTokenHash(hashSessionToken(token));

    if (session === undefined || session.revokedAt !== null) {
      return;
    }

    await this.sessions.revoke(session.id, now);
    await this.audit.append({
      tenantId: session.tenantId,
      actorUserId: session.userId,
      action: AUDIT_ACTION.LOGOUT,
      resourceType: AUDIT_RESOURCE_TYPE.SESSION,
      resourceId: session.id,
      ip: meta.ip,
      userAgent: truncate(meta.userAgent ?? undefined, 512),
      now,
    });
  }

  async changePassword(context: AuthContext, input: ChangePasswordInput): Promise<void> {
    const currentMatches = await verifyPassword(context.user.passwordHash, input.currentPassword);

    if (!currentMatches) {
      throw new InvalidCredentialsError('Current password is incorrect');
    }

    const issues = passwordPolicyIssues(input.newPassword);

    if (issues.length > 0) {
      throw new ValidationError(
        'Password does not meet policy',
        issues.map((message) => ({ path: 'newPassword', message, code: 'invalid_password' })),
      );
    }

    if (await verifyPassword(context.user.passwordHash, input.newPassword)) {
      throw new ValidationError('New password must be different from the current password');
    }

    const now = this.now();
    const passwordHash = await hashPassword(input.newPassword);

    await this.users.updatePasswordHash(context.user.id, passwordHash, now);
    await this.sessions.revokeAllForUser(context.user.id, now, context.session.id);
    await this.audit.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PASSWORD_CHANGE,
      resourceType: AUDIT_RESOURCE_TYPE.USER,
      resourceId: context.user.id,
      detail: { revokedOtherSessions: true },
      now,
    });
  }

  async switchTenant(context: AuthContext, tenantId: string): Promise<SwitchTenantResult> {
    const access = await this.access.findActiveForUser(context.user.id, tenantId);

    if (access === undefined) {
      throw new NotFoundError('Tenant not found');
    }

    const now = this.now();

    if (tenantId !== context.tenant.id) {
      await this.sessions.setActiveTenant(context.session.id, tenantId, now);
      await this.audit.append({
        tenantId,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.TENANT_SWITCH,
        resourceType: AUDIT_RESOURCE_TYPE.TENANT,
        resourceId: tenantId,
        detail: { fromTenantId: context.tenant.id, toTenantId: tenantId },
        now,
      });
    }

    const tenants = await this.access.listActiveForUser(context.user.id);

    return {
      activeTenant: toTenantSummary(access),
      tenants: tenants.map(toTenantSummary),
      permissions: permissionsForRole(access.role),
    };
  }

  async listTenantAccess(userId: string): Promise<TenantAccess[]> {
    const accesses = await this.access.listActiveForUser(userId);

    return accesses;
  }

  async buildSessionSummary(context: AuthContext): Promise<AuthSessionSummary> {
    const tenants = await this.access.listActiveForUser(context.user.id);

    return {
      user: toAuthUserSummary(context.user),
      activeTenant: {
        id: context.tenant.id,
        slug: context.tenant.slug,
        name: context.tenant.name,
        role: context.role,
      },
      tenants: tenants.map(toTenantSummary),
      permissions: context.permissions,
    };
  }

  private async writeLoginFailure(
    user: User | null,
    username: string,
    meta: RequestMeta,
    reason: string,
  ): Promise<void> {
    const tenantId =
      user === null ? null : ((await this.access.listActiveForUser(user.id))[0]?.tenant.id ?? null);

    await this.audit.append({
      tenantId,
      actorUserId: user?.id ?? null,
      action: AUDIT_ACTION.LOGIN_FAILURE,
      resourceType: AUDIT_RESOURCE_TYPE.USER,
      resourceId: user?.id ?? null,
      ip: meta.ip,
      userAgent: truncate(meta.userAgent ?? undefined, 512),
      detail: { username, reason },
    });
  }
}
