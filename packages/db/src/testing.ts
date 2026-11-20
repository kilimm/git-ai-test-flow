// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './client.js';
import type { OpenedDatabase } from './client.js';
import { runMigrations } from './migrate.js';

export interface TestDatabase extends OpenedDatabase {
  readonly path: string;
  cleanup(): void;
}

/**
 * 创建独立的临时 SQLite 测试库，并执行全部迁移。
 * 使用文件而非 :memory:，确保 WAL、外键与锁行为与生产一致。
 */
export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'gait-db-'));
  const path = join(directory, 'test.db');
  const database = openDatabase({ path });

  try {
    runMigrations(database);
  } catch (error) {
    database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    database.close();
  };

  return {
    sqlite: database.sqlite,
    db: database.db,
    path,
    close,
    cleanup() {
      close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
