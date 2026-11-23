// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/client.js';

describe('openDatabase', () => {
  it('creates a pg pool from DATABASE_URL and closes it', async () => {
    const url = 'postgresql://gait:secret@localhost:5432/gait';
    const database = openDatabase({ url, maxConnections: 3 });

    expect(database.pool.options.connectionString).toBe(url);
    expect(database.pool.options.max).toBe(3);
    await database.close();
  });

  it('rejects an invalid connection URL', () => {
    expect(() => openDatabase({ url: 'not-a-url' })).toThrow(/Invalid database URL/);
  });
});
