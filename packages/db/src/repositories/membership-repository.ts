// 本文件所有改动要求遵循 agent-rules 规范
import { and, asc, eq, sql } from 'drizzle-orm';
import { nowMs } from '@gait/config';
import { MEMBER_STATUS, TENANT_STATUS } from '@gait/shared';
import type { MemberStatus, TenantRole, UserStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, TenantScopedRepository } from '../repository.js';
import { tenantMembers, tenants, users } from '../schema.js';
import type { Tenant, TenantMember } from '../schema.js';

export interface MemberWithUser {
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: MemberStatus;
  createdAt: number;
  updatedAt: number;
  username: string;
  displayName: string;
  email: string | null;
  userStatus: UserStatus;
  lastLoginAt: number | null;
}

export interface TenantAccess {
  tenant: Tenant;
  role: TenantRole;
  memberStatus: MemberStatus;
}

export interface AddMemberInput {
  userId: string;
  role: TenantRole;
  status?: MemberStatus;
  now?: number;
}

const memberSelection = {
  tenantId: tenantMembers.tenantId,
  userId: tenantMembers.userId,
  role: tenantMembers.role,
  status: tenantMembers.status,
  createdAt: tenantMembers.createdAt,
  updatedAt: tenantMembers.updatedAt,
  username: users.username,
  displayName: users.displayName,
  email: users.email,
  userStatus: users.status,
  lastLoginAt: users.lastLoginAt,
};

function toMemberWithUser(row: {
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: MemberStatus;
  createdAt: number;
  updatedAt: number;
  username: string;
  displayName: string;
  email: string | null;
  userStatus: UserStatus;
  lastLoginAt: number | null;
}): MemberWithUser {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    userStatus: row.userStatus,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * 租户内成员仓储。所有查询都强制追加实例携带的 tenant_id，
 * 即使调用方传入其它租户的用户 ID 也不会命中。
 */
export class MembershipRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  list(): MemberWithUser[] {
    return this.db
      .select(memberSelection)
      .from(tenantMembers)
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(eq(tenantMembers.tenantId, this.tenantId))
      .orderBy(asc(users.username))
      .all()
      .map(toMemberWithUser);
  }

  find(userId: string): MemberWithUser | undefined {
    const row = this.db
      .select(memberSelection)
      .from(tenantMembers)
      .innerJoin(users, eq(tenantMembers.userId, users.id))
      .where(and(eq(tenantMembers.tenantId, this.tenantId), eq(tenantMembers.userId, userId)))
      .get();

    return row === undefined ? undefined : toMemberWithUser(row);
  }

  add(input: AddMemberInput): TenantMember {
    const now = input.now ?? nowMs();

    return this.db
      .insert(tenantMembers)
      .values({
        tenantId: this.tenantId,
        userId: input.userId,
        role: input.role,
        status: input.status ?? MEMBER_STATUS.ACTIVE,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  updateRole(userId: string, role: TenantRole, now: number = nowMs()): boolean {
    const result = this.db
      .update(tenantMembers)
      .set({ role, updatedAt: now })
      .where(and(eq(tenantMembers.tenantId, this.tenantId), eq(tenantMembers.userId, userId)))
      .run();

    return result.changes > 0;
  }

  remove(userId: string): boolean {
    const result = this.db
      .delete(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, this.tenantId), eq(tenantMembers.userId, userId)))
      .run();

    return result.changes > 0;
  }

  countActiveOwners(): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.tenantId, this.tenantId),
          eq(tenantMembers.role, 'owner'),
          eq(tenantMembers.status, MEMBER_STATUS.ACTIVE),
        ),
      )
      .get();

    return row?.count ?? 0;
  }
}

/** 跨租户查询用户的可访问租户；仅供会话与 /me 使用。 */
export class MembershipAccessRepository extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  listActiveForUser(userId: string): TenantAccess[] {
    return (
      this.db
        .select({
          tenant: tenants,
          role: tenantMembers.role,
          memberStatus: tenantMembers.status,
        })
        .from(tenantMembers)
        .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
        .where(
          and(
            eq(tenantMembers.userId, userId),
            eq(tenantMembers.status, MEMBER_STATUS.ACTIVE),
            eq(tenants.status, TENANT_STATUS.ACTIVE),
          ),
        )
        // 登录默认选最早加入的租户；同毫秒时用租户 ID 保证顺序稳定。
        .orderBy(asc(tenantMembers.createdAt), asc(tenants.id))
        .all()
    );
  }

  findActiveForUser(userId: string, tenantId: string): TenantAccess | undefined {
    return this.db
      .select({
        tenant: tenants,
        role: tenantMembers.role,
        memberStatus: tenantMembers.status,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(
        and(
          eq(tenantMembers.userId, userId),
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.status, MEMBER_STATUS.ACTIVE),
          eq(tenants.status, TENANT_STATUS.ACTIVE),
        ),
      )
      .get();
  }
}
