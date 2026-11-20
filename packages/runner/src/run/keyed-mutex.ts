// 本文件所有改动要求遵循 agent-rules 规范

/**
 * 进程内按 key 串行化：用于 mirror 同步与共享环境互斥。
 * 跨进程互斥仍由 Worker 单并发与 Run 状态检查保证。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** 获取一个跨阶段持有的锁；调用方必须在 finally 中释放。 */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.then(() => gate);

    this.tails.set(key, tail);

    try {
      await previous;
    } catch {
      // 前一个持有者失败不影响后续获取。
    }

    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }

      released = true;
      releaseGate();

      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };

    return release;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);

    try {
      return await task();
    } finally {
      release();
    }
  }
}

export const mirrorMutex = new KeyedMutex();
export const environmentMutex = new KeyedMutex();
