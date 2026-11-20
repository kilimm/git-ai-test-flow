// 本文件所有改动要求遵循 agent-rules 规范
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSeparateDatabasePaths } from '../src/config.js';

describe('assertSeparateDatabasePaths', () => {
  it('allows distinct paths, including equivalent relative and absolute forms', () => {
    expect(() =>
      assertSeparateDatabasePaths('./data/app.db', './data/checkpoints/checkpoints.db'),
    ).not.toThrow();
    expect(() =>
      assertSeparateDatabasePaths('data/checkpoints/checkpoints.db', './data/app.db'),
    ).not.toThrow();
  });

  it('rejects the same database file for app and checkpoints', () => {
    expect(() => assertSeparateDatabasePaths('./data/app.db', resolve('./data/app.db'))).toThrow(
      /must point to different files/,
    );
  });

  it('allows in-memory databases', () => {
    expect(() => assertSeparateDatabasePaths(':memory:', ':memory:')).not.toThrow();
  });
});
