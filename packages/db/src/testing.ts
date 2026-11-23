// 本文件所有改动要求遵循 agent-rules 规范
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { AppDatabase } from './client.js';
import { MIGRATIONS_FOLDER } from './migrate.js';
import * as schema from './schema.js';

export interface TestDatabase {
  pglite: PGlite;
  db: AppDatabase;
  cleanup(): Promise<void>;
}

/**
 * 创建进程内 PostgreSQL（PGlite）测试库并执行全部迁移。
 * 每个测试文件使用独立实例，天然隔离；用完调用 cleanup() 释放。
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  const pgliteDb: PgliteDatabase<typeof schema> = drizzle(pglite, { schema });

  await pglite.waitReady;
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });

  let closed = false;

  return {
    pglite,
    // PGlite 与 node-postgres 共用 PG 查询构建器，运行时行为一致。
    db: pgliteDb as unknown as AppDatabase,
    async cleanup(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await pglite.close();
    },
  };
}
