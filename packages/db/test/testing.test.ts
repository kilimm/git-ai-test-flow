// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing.js';

describe('createTestDatabase', () => {
  it('removes the temporary database directory on cleanup', () => {
    const database = createTestDatabase();
    const path = database.path;

    expect(existsSync(path)).toBe(true);

    database.cleanup();

    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });
});
