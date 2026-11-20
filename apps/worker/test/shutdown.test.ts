// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it, vi } from 'vitest';
import { createWorkerShutdown } from '../src/shutdown.js';
import type { WorkerLogger } from '../src/worker.js';

function createSilentLogger(): WorkerLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('createWorkerShutdown', () => {
  it('closes resources once across repeated signals', async () => {
    const stop = vi.fn(async () => {});
    const closeCheckpoint = vi.fn();
    const closeDatabase = vi.fn();
    const shutdown = createWorkerShutdown({
      worker: { stop },
      checkpoint: { close: closeCheckpoint },
      database: { close: closeDatabase },
      logger: createSilentLogger(),
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(closeCheckpoint).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it('closes the database even when checkpoint shutdown fails', async () => {
    const closeDatabase = vi.fn();
    const shutdown = createWorkerShutdown({
      worker: { stop: async () => {} },
      checkpoint: {
        close: () => {
          throw new Error('checkpoint close failed');
        },
      },
      database: { close: closeDatabase },
      logger: createSilentLogger(),
    });

    await expect(shutdown('SIGTERM')).rejects.toThrow('checkpoint close failed');
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
