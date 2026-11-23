// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import type { CheckpointStore } from '../src/checkpoint.js';
import { CHECKPOINT_PROBE_THREAD_ID, openCheckpointStore } from '../src/checkpoint.js';

const CHECKPOINT_DATABASE_URL = process.env['CHECKPOINT_TEST_DATABASE_URL'];
const checkpointConfigured =
  CHECKPOINT_DATABASE_URL !== undefined && CHECKPOINT_DATABASE_URL.length > 0;

const stores: CheckpointStore[] = [];
const databases: TestDatabase[] = [];

function requireCheckpointUrl(): string {
  const url = CHECKPOINT_DATABASE_URL;

  if (url === undefined || url.length === 0) {
    throw new Error('CHECKPOINT_TEST_DATABASE_URL is required for checkpoint integration tests');
  }

  return url;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }

  for (const database of databases.splice(0)) {
    await database.cleanup();
  }
});

describe('openCheckpointStore failures', () => {
  it('rethrows and releases the pool when PostgreSQL is unreachable', async () => {
    await expect(
      openCheckpointStore('postgresql://postgres:postgres@127.0.0.1:1/gait_checkpoints'),
    ).rejects.toThrow();
  }, 30_000);
});

// 未提供真实 PostgreSQL 连接串时整体跳过；PGlite 无法被 PostgresSaver 访问。
describe.skipIf(!checkpointConfigured)('openCheckpointStore', () => {
  it('initializes the PostgreSQL checkpoint schema and probes an empty tuple', async () => {
    const store = await openCheckpointStore(requireCheckpointUrl());
    stores.push(store);

    const checkpoint = await store.saver.getTuple({
      configurable: { thread_id: CHECKPOINT_PROBE_THREAD_ID },
    });

    expect(checkpoint).toBeUndefined();
  });

  it('keeps LangGraph tables out of the application database', async () => {
    const appDatabase = await createTestDatabase();
    databases.push(appDatabase);

    const { rows } = await appDatabase.pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = rows.map((row) => row.table_name);

    expect(names).not.toContain('checkpoints');
    expect(names).not.toContain('writes');

    const store = await openCheckpointStore(requireCheckpointUrl());
    stores.push(store);
  });

  it('closes the checkpoint store idempotently', async () => {
    const store = await openCheckpointStore(requireCheckpointUrl());
    stores.push(store);

    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
