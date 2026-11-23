// 本文件所有改动要求遵循 agent-rules 规范
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Pool } from 'pg';

export const CHECKPOINT_PROBE_THREAD_ID = '__gait_checkpoint_init__';

export interface CheckpointStore {
  readonly saver: PostgresSaver;
  close(): Promise<void>;
}

export interface OpenCheckpointStoreOptions {
  /** 建立连接的超时时间；默认 10 秒，避免数据库黑洞时启动长时间挂起。 */
  connectionTimeoutMs?: number;
  /** 空闲连接出错时的回调；默认写入 stderr，避免未监听的 error 事件导致进程退出。 */
  onPoolError?: (error: Error) => void;
}

/**
 * 初始化独立的 LangGraph checkpoint 库（与业务库分离）。
 * setup() 负责创建 checkpoint 表；随后用一次空读取验证连接与表结构，
 * 让启动阶段就能暴露权限或网络错误，而不是等到第一个工作流。
 */
export async function openCheckpointStore(
  connectionString: string,
  options: OpenCheckpointStoreOptions = {},
): Promise<CheckpointStore> {
  const pool = new Pool({
    connectionString,
    max: 5,
    application_name: 'gait-checkpoint',
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  });
  const onPoolError =
    options.onPoolError ??
    ((error: Error): void => {
      process.stderr.write(`[gait-checkpoint] idle client error: ${error.message}\n`);
    });

  pool.on('error', onPoolError);

  const saver = new PostgresSaver(pool);

  try {
    await saver.setup();
    await saver.getTuple({
      configurable: { thread_id: CHECKPOINT_PROBE_THREAD_ID },
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  let closed = false;

  return {
    saver,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await pool.end();
    },
  };
}
