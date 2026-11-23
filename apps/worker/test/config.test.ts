// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { assertSeparateDatabases } from '../src/config.js';

const APP_URL = 'postgresql://gait:secret@localhost:5432/gait';
const CHECKPOINT_URL = 'postgresql://gait:secret@localhost:5432/gait_checkpoints';

describe('assertSeparateDatabases', () => {
  it('allows distinct databases', () => {
    expect(() => assertSeparateDatabases(APP_URL, CHECKPOINT_URL)).not.toThrow();
  });

  it('rejects the same database even when credentials differ', () => {
    expect(() =>
      assertSeparateDatabases(APP_URL, 'postgresql://other:other@localhost:5432/gait'),
    ).toThrow(/different databases/);
    expect(() => assertSeparateDatabases(APP_URL, APP_URL)).toThrow(/different databases/);
  });

  it('normalizes the default port and protocol when comparing targets', () => {
    expect(() =>
      assertSeparateDatabases(
        'postgresql://gait:secret@localhost/gait',
        'postgres://other:other@localhost:5432/gait',
      ),
    ).toThrow(/different databases/);
  });
});
