// 本文件所有改动要求遵循 agent-rules 规范
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * M1 只建立租户根表，作为迁移与租户隔离的基座。
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
