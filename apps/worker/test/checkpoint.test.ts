// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLITE_BUSY_TIMEOUT_MS } from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import type { CheckpointStore } from '../src/checkpoint.js';
import { CHECKPOINT_PROBE_THREAD_ID, openCheckpointStore } from '../src/checkpoint.js';

const directories: string[] = [];
const stores: CheckpointStore[] = [];
const databases: TestDatabase[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-checkpoint-'));
  directories.push(directory);
  return directory;
}

function tableNames(sqlite: { prepare(sql: string): { all(): unknown } }): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const database of databases.splice(0)) {
    database.cleanup();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('openCheckpointStore', () => {
  it('creates the checkpoint schema in a separate database file', async () => {
    const path = join(createDirectory(), 'nested', 'checkpoints.db');
    const store = await openCheckpointStore(path);
    stores.push(store);

    expect(tableNames(store.saver.db)).toEqual(['checkpoints', 'writes']);
    expect(store.saver.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.saver.db.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(store.saver.db.name).toBe(path);

    const checkpoint = await store.saver.getTuple({
      configurable: { thread_id: CHECKPOINT_PROBE_THREAD_ID },
    });
    expect(checkpoint).toBeUndefined();
  });

  it('keeps LangGraph tables out of the application database', async () => {
    const appDatabase = createTestDatabase();
    databases.push(appDatabase);

    const store = await openCheckpointStore(join(createDirectory(), 'checkpoints.db'));
    stores.push(store);

    expect(tableNames(appDatabase.sqlite)).not.toContain('checkpoints');
    expect(tableNames(appDatabase.sqlite)).not.toContain('writes');
    expect(tableNames(store.saver.db)).toEqual(['checkpoints', 'writes']);
  });

  it('closes the checkpoint database idempotently', async () => {
    const store = await openCheckpointStore(join(createDirectory(), 'checkpoints.db'));

    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });
});
