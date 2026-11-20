// 本文件所有改动要求遵循 agent-rules 规范
import { desc } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { JobStatus } from '@gait/shared';

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;

/**
 * M1 建立租户根表与任务队列表，作为迁移、租户隔离与 Worker 消费链路的基座。
 * 用户、项目、运行等业务表随对应里程碑的迁移加入。
 */
export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  settingsJson: text('settings_json').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

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
