// 本文件所有改动要求遵循 agent-rules 规范
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { OpenedDatabase } from './client.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export function runMigrations(
  database: OpenedDatabase,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): void {
  migrate(database.db, { migrationsFolder });
}
