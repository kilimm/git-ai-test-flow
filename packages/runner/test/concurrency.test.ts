// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { KeyedMutex, mapWithConcurrency } from '../src/index.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('run concurrency helpers', () => {
  it('limits parallelism, preserves order and stops on abort', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(10);
      active -= 1;

      return item * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);

    const controller = new AbortController();

    setImmediate(() => controller.abort());

    await expect(
      mapWithConcurrency(
        [1, 2, 3],
        1,
        async (item) => {
          await delay(20);

          return item;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('serializes work per key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const firstRelease = await mutex.acquire('environment:one');

    events.push('first-acquired');
    const second = mutex.acquire('environment:one').then((release) => {
      events.push('second-acquired');

      return release;
    });
    const third = mutex.run('environment:one', async () => {
      events.push('third-ran');
    });

    await delay(10);
    expect(events).toEqual(['first-acquired']);
    firstRelease();
    const secondRelease = await second;

    expect(events).toEqual(['first-acquired', 'second-acquired']);
    secondRelease();
    await third;
    expect(events).toEqual(['first-acquired', 'second-acquired', 'third-ran']);
  });
});
