// 本文件所有改动要求遵循 agent-rules 规范
import { desc } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AuditAction,
  JobStatus,
  MemberStatus,
  TenantRole,
  TenantStatus,
  UserStatus,
} from '@gait/shared';

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;

/**
 * M1 建立租户根表与任务队列表；M2 增加用户、成员、会话与审计表。
 * 项目、运行等业务表随对应里程碑的迁移加入。
 */
export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').$type<TenantStatus>().notNull().default('active'),
  settingsJson: text('settings_json').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * 用户是全局身份，不属于任何租户；租户归属由 tenant_members 表达。
 * 用户名统一以小写存储，唯一索引保证全局唯一。
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').$type<UserStatus>().notNull().default('active'),
  isPlatformAdmin: integer('is_platform_admin', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: integer('last_login_at', { mode: 'number' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** 用户与租户的成员关系；角色和状态都挂在成员关系上。 */
export const tenantMembers = sqliteTable(
  'tenant_members',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<TenantRole>().notNull(),
    status: text('status').$type<MemberStatus>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index('idx_tenant_members_user').on(table.userId),
  ],
);

export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;

/**
 * 会话只保存 token 的 SHA-256 哈希，不保存明文 token。
 * expires_at 为绝对过期时间；last_seen_at 用于 24 小时空闲过期。
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: text('tenant_id').references(() => tenants.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'number' }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_sessions_user').on(table.userId),
    index('idx_sessions_expires').on(table.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * 审计日志 append-only。tenant_id 允许为空：失败登录尚未解析出租户时仍需记录。
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id),
    actorUserId: text('actor_user_id').references(() => users.id),
    action: text('action').$type<AuditAction>().notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    detailJson: text('detail_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_audit_logs_tenant_created').on(table.tenantId, desc(table.createdAt)),
    index('idx_audit_logs_action').on(table.action),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * SQLite 任务队列。领取与心跳都依赖 `locked_by + lease_expires_at`：
 * Worker 崩溃后，过期租约由清理逻辑回收，不依赖进程内状态。
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAfter: integer('run_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(DEFAULT_JOB_MAX_ATTEMPTS),
    lockedBy: text('locked_by'),
    leaseExpiresAt: integer('lease_expires_at'),
    dedupeKey: text('dedupe_key').unique(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_jobs_claim').on(table.status, table.runAfter, desc(table.priority), table.createdAt),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
