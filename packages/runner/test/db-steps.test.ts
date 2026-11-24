// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore, HttpExecutor, createDbAdapter, executeDbStep } from '../src/index.js';
import type { DbAdapter, StepMatch, StepRuntime } from '../src/index.js';

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-db-steps-'));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function match(): StepMatch {
  return {
    definition: { name: 'test', type: 'db', pattern: 'x' },
    params: [],
    type: 'db',
  };
}

function runtime(dataDir: string, adapter: DbAdapter): StepRuntime {
  return {
    variables: {
      env: {},
      fixture: {},
      secret: {},
      var: {},
      steps: {},
      run: { namespace: 'run_abcd1234_' },
    },
    environment: {
      apiBaseUrl: 'http://127.0.0.1:1',
      webBaseUrl: null,
      testAccount: null,
      caseTimeoutMs: 5_000,
    },
    http: new HttpExecutor({ baseUrl: 'http://127.0.0.1:1' }),
    db: adapter,
    suiteRoot: dataDir,
    artifacts: new ArtifactStore({ dataDir, tenantId: 'tenant-1', runId: 'run-1' }),
    uiFactory: null,
    ui: null,
    apiAgent: null,
    signal: undefined,
    headers: {},
    lastResponse: null,
    identity: {
      runId: 'run-1',
      runCaseId: 'case-1',
      featurePath: 'features/db/posts.feature',
      scenarioName: 'posts',
      caseKey: 'DB-001',
      tags: ['layer:db'],
      layer: 'db',
      namespace: 'run_abcd1234_',
    },
  };
}

describe('database steps', () => {
  it('asserts row counts, query results and snapshots', async () => {
    const dataDir = tempDir();
    const path = join(dataDir, 'product.db');
    const setup = new Database(path);

    setup.exec(
      "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL); CREATE TABLE empty_posts (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO posts (title) VALUES ('hello');",
    );
    setup.close();

    const adapter = createDbAdapter({
      type: 'sqlite',
      name: path,
      ssl: false,
      isTest: true,
      writeMode: 'fixtures',
    });
    const state = runtime(dataDir, adapter);

    try {
      const count = await executeDbStep('db-row-count-plural', ['posts', '1'], match(), state, 1);

      expect(count.output).toMatchObject({ table: 'posts', rowCount: 1 });
      expect(count.artifacts[0]?.type).toBe('db_snapshot');

      const where = await executeDbStep(
        'db-row-count-where',
        ['posts', '1', 'title', 'hello'],
        match(),
        state,
        2,
      );

      expect(where.output).toMatchObject({ rowCount: 1 });

      const queryCount = await executeDbStep(
        'db-query-row-count',
        ['SELECT * FROM posts', '1'],
        match(),
        state,
        3,
      );

      expect(queryCount.output).toMatchObject({ rowCount: 1 });

      const contains = await executeDbStep(
        'db-query-contains',
        ['SELECT * FROM posts', 'hello'],
        match(),
        state,
        4,
      );

      expect(contains.output).toMatchObject({ rowCount: 1 });

      const empty = await executeDbStep('db-empty', ['empty_posts'], match(), state, 5);

      expect(empty.output).toMatchObject({ table: 'empty_posts', rowCount: 0 });

      await expect(
        executeDbStep('db-row-count', ['posts', '2'], match(), state, 6),
      ).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
      await expect(
        executeDbStep('db-query-row-count', ['SELECT * FROM posts', '2'], match(), state, 7),
      ).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
      await expect(executeDbStep('db-empty', ['posts'], match(), state, 8)).rejects.toMatchObject({
        code: 'ASSERTION_FAILED',
      });
    } finally {
      await adapter.close();
    }
  });

  it('reports missing database configuration and unavailable connections', async () => {
    const dataDir = tempDir();
    const state = runtime(
      dataDir,
      createDbAdapter({
        type: 'sqlite',
        name: join(dataDir, 'missing.db'),
        ssl: false,
        isTest: true,
        writeMode: 'readonly',
      }),
    );

    try {
      await expect(
        executeDbStep('db-row-count', ['posts', '1'], match(), state, 1),
      ).rejects.toMatchObject({ code: 'DB_QUERY_FAILED' });
    } finally {
      await state.db?.close();
    }

    const noDb = { ...runtime(dataDir, state.db as DbAdapter), db: null };

    await expect(
      executeDbStep('db-row-count', ['posts', '1'], match(), noDb, 1),
    ).rejects.toMatchObject({ code: 'DB_NOT_CONFIGURED' });
  });
});
