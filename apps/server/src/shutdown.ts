// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';

export type ShutdownApp = Pick<FastifyInstance, 'close' | 'log'>;
export type ShutdownHandler = (signal: NodeJS.Signals) => Promise<void>;

/**
 * 幂等的优雅退出：首次信号关闭 Fastify，后续信号复用同一个 Promise。
 */
export function createGracefulShutdown(app: ShutdownApp): ShutdownHandler {
  let shutdownPromise: Promise<void> | undefined;

  return (signal) => {
    shutdownPromise ??= (async () => {
      app.log.info({ signal }, 'shutting down');

      try {
        await app.close();
        app.log.info({ signal }, 'shutdown complete');
      } catch (error) {
        app.log.error({ err: error, signal }, 'shutdown failed');
        throw error;
      }
    })();

    return shutdownPromise;
  };
}
