// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing.js';

describe('createTestDatabase', () => {
  it('creates an in-process PostgreSQL database and closes it on cleanup', async () => {
    const database = await createTestDatabase();

    expect(database.pglite.closed).toBe(false);

    const result = await database.pglite.query<{ value: number }>('SELECT 1::int AS value');
    expect(result.rows[0]?.value).toBe(1);

    await database.cleanup();
    expect(database.pglite.closed).toBe(true);
  });

  it('is idempotent when cleanup runs more than once', async () => {
    const database = await createTestDatabase();

    await database.cleanup();
    await expect(database.cleanup()).resolves.toBeUndefined();
    expect(database.pglite.closed).toBe(true);
  });
});
