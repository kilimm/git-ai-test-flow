// 本文件所有改动要求遵循 agent-rules 规范
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { OpenedDatabase } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** 对生产/开发数据库执行 PostgreSQL 迁移（drizzle-kit 生成的 SQL 目录）。 */
export async function runMigrations(
  database: OpenedDatabase,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(database.db, { migrationsFolder });
}
