// 本文件所有改动要求遵循 agent-rules 规范
import { resolve } from 'node:path';

/**
 * LangGraph checkpoint 必须使用独立数据库文件。这里在启动阶段拦截同一路径，
 * 避免 checkpoint 表与业务表混用后出现锁竞争和迁移污染。
 */
export function assertSeparateDatabasePaths(databasePath: string, checkpointPath: string): void {
  if (databasePath === ':memory:' || checkpointPath === ':memory:') {
    return;
  }

  if (resolve(databasePath) === resolve(checkpointPath)) {
    throw new Error('DATABASE_PATH and CHECKPOINT_DB_PATH must point to different files');
  }
}
