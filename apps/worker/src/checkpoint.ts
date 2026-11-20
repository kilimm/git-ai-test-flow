// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { SQLITE_BUSY_TIMEOUT_MS } from '@gait/db';

export const CHECKPOINT_PROBE_THREAD_ID = '__gait_checkpoint_init__';

export interface CheckpointStore {
  readonly saver: SqliteSaver;
  close(): void;
}

/**
 * 初始化独立的 LangGraph checkpoint 库（与业务库 app.db 分离）。
 * SqliteSaver 在首次访问时按需建表，这里用一次空读取触发 setup，
 * 让启动阶段就能暴露路径、权限或磁盘错误，而不是等到第一个工作流。
 */
export async function openCheckpointStore(path: string): Promise<CheckpointStore> {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const saver = SqliteSaver.fromConnString(path);

  try {
    saver.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    saver.db.pragma('synchronous = NORMAL');
    await saver.getTuple({
      configurable: { thread_id: CHECKPOINT_PROBE_THREAD_ID },
    });
  } catch (error) {
    saver.db.close();
    throw error;
  }

  let closed = false;

  return {
    saver,
    close() {
      if (closed) {
        return;
      }

      closed = true;
      saver.db.close();
    },
  };
}
