// 本文件所有改动要求遵循 agent-rules 规范

export class AbortedError extends Error {
  readonly code = 'ABORTED';

  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AbortedError();
  }
}

/** 保持结果顺序的并发映射；任一任务抛错时停止领取新任务。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  let nextIndex = 0;
  let failure: unknown;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted === true || failure !== undefined) {
        return;
      }

      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        failure = error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => runWorker()));

  if (failure !== undefined) {
    throw failure;
  }

  if (signal?.aborted === true) {
    throw new AbortedError();
  }

  return results;
}

/** 可中止的延时，用于 wait 步骤与轮询。 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new AbortedError());
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
