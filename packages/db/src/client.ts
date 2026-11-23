// 本文件所有改动要求遵循 agent-rules 规范
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

/**
 * 应用数据库句柄。仓储层只依赖 drizzle 的 PG 查询构建器，
 * 运行时由 pg.Pool 提供连接，测试环境由 PGlite 提供同构实现。
 */
export type AppDatabase = NodePgDatabase<typeof schema>;

export interface OpenDatabaseOptions {
  url: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
  applicationName?: string;
  /** 空闲连接出错时的回调；默认写入 stderr，避免未监听的 error 事件导致进程退出。 */
  onPoolError?: (error: Error) => void;
}

export interface OpenedDatabase {
  pool: Pool;
  db: AppDatabase;
  close(): Promise<void>;
}

function assertPostgresUrl(url: string): void {
  try {
    const { protocol } = new URL(url);

    if (protocol === 'postgres:' || protocol === 'postgresql:') {
      return;
    }
  } catch {
    // 落到统一错误分支。
  }

  throw new Error('Invalid database URL: expected postgres:// or postgresql://');
}

export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  assertPostgresUrl(options.url);

  const poolConfig: PoolConfig = {
    connectionString: options.url,
    application_name: options.applicationName ?? 'gait',
  };

  if (options.maxConnections !== undefined) {
    poolConfig.max = options.maxConnections;
  }

  if (options.connectionTimeoutMs !== undefined) {
    poolConfig.connectionTimeoutMillis = options.connectionTimeoutMs;
  }

  const pool = new Pool(poolConfig);
  const onPoolError =
    options.onPoolError ??
    ((error: Error): void => {
      // pg 的 Pool 会把空闲连接错误作为 error 事件抛出；没有监听器时 Node 会直接崩溃。
      process.stderr.write(`[gait-db] idle client error: ${error.message}\n`);
    });

  pool.on('error', onPoolError);

  return {
    pool,
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
