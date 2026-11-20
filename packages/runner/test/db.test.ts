// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDbAdapter,
  createFixtureContext,
  parseFixtureDocument,
  runFixtureSetup,
  assertFixtureSql,
  assertIdentifier,
  assertReadSql,
  assertSingleStatement,
  classifySql,
  placeholderFor,
  quoteIdentifier,
} from '../src/index.js';
import type { DbAdapterConfig, MysqlConnectionLike, PgClientLike } from '../src/index.js';

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-runner-db-'));
  directories.push(directory);

  return directory;
}

function sqliteConfig(path: string, overrides: Partial<DbAdapterConfig> = {}): DbAdapterConfig {
  return {
    type: 'sqlite',
    name: path,
    ssl: false,
    isTest: true,
    writeMode: 'fixtures',
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('sql guard', () => {
  it('classifies statements and rejects multi-statement/DDL/writes', () => {
    expect(classifySql('SELECT * FROM posts')).toBe('read');
    expect(classifySql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
    expect(classifySql('INSERT INTO posts (title) VALUES (?)')).toBe('write');
    expect(classifySql('DROP TABLE posts')).toBe('ddl');
    expect(() => assertSingleStatement('SELECT 1; SELECT 2')).toThrow(/single SQL/);
    expect(() => assertSingleStatement('SELECT 1 -- comment')).toThrow(/comments/);
    expect(() => assertFixtureSql('CREATE TABLE x (id INT)')).toThrow(/DDL/);
    expect(() => assertFixtureSql('SELECT 1')).toThrow(/DML/);
    expect(() => assertReadSql('DELETE FROM posts')).toThrow(/read-only/);
    expect(() => assertReadSql('SELECT * INTO backup FROM posts')).toThrow(/read-only/);
    expect(() => assertIdentifier('posts; DROP TABLE users')).toThrow(/Invalid SQL/);
    expect(quoteIdentifier('public.posts', 'postgresql')).toBe('"public"."posts"');
    expect(quoteIdentifier('posts', 'mysql')).toBe('`posts`');
    expect(placeholderFor('postgresql', 2)).toBe('$2');
  });
});

describe('database adapters', () => {
  it('runs read-only queries and guarded fixtures against SQLite', async () => {
    const path = join(tempDir(), 'product.db');
    const sqlite = new Database(path);

    sqlite.exec(
      'CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, secret TEXT)',
    );
    sqlite.close();

    const adapter = createDbAdapter(sqliteConfig(path));

    expect((await adapter.ping()).ok).toBe(true);
    await expect(adapter.query('DELETE FROM posts')).rejects.toThrow(/read-only/);
    await expect(adapter.execute('CREATE TABLE hack (id INT)')).rejects.toThrow(/DML|DDL/);

    const source = [
      'variables:',
      '  title: "{{run.namespace}}hello"',
      'setup:',
      '  - table: posts',
      '    rows:',
      '      - title: "{{run.namespace}}hello"',
      '        secret: "{{run.namespace}}secret"',
      'teardown:',
      '  - sql: "DELETE FROM posts WHERE title LIKE ?"',
      '    params: ["{{run.namespace}}%"]',
    ].join('\n');
    const document = parseFixtureDocument(source, 'fixtures.yml');
    const context = createFixtureContext({ run: {} }, 'run_abc12345_');
    const setup = await runFixtureSetup(adapter, document, context);

    expect(setup.statements).toBe(1);
    const rows = await adapter.query('SELECT title, secret FROM posts');

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.title).toBe('run_abc12345_hello');
    expect(rows.rows[0]?.secret).toBe('run_abc12345_secret');

    expect(await setup.teardown()).toBe(1);
    expect((await adapter.query('SELECT * FROM posts')).rows).toHaveLength(0);
    await adapter.close();
  });

  it('rejects writes in readonly mode and production writes', async () => {
    const path = join(tempDir(), 'readonly.db');
    const setup = new Database(path);

    setup.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
    setup.close();

    const adapter = createDbAdapter(sqliteConfig(path, { writeMode: 'readonly' }));

    await expect(adapter.execute('INSERT INTO posts (title) VALUES (?)', ['x'])).rejects.toThrow(
      /writeMode is readonly/,
    );
    await adapter.close();

    expect(() =>
      createDbAdapter(sqliteConfig(path, { isTest: false, writeMode: 'fixtures' })),
    ).toThrow(/Production database/);
  });

  it('supports MySQL parameter binding through an injected driver', async () => {
    const calls: string[] = [];
    const connection: MysqlConnectionLike = {
      async query(sql, params) {
        calls.push(`${sql} :: ${JSON.stringify(params)}`);

        return [[{ count: 1 }], []] as [unknown, unknown];
      },
      async end() {
        return;
      },
    };
    const adapter = createDbAdapter(
      {
        type: 'mysql',
        host: 'db.example.test',
        name: 'app',
        ssl: false,
        isTest: true,
        writeMode: 'fixtures',
      },
      { mysqlCreateConnection: async () => connection },
    );

    const result = await adapter.query('SELECT COUNT(*) AS count FROM posts WHERE id = ?', [1]);

    expect(result.rows[0]?.count).toBe(1);
    expect(calls[0]).toContain('?');
    expect(calls[0]).toContain('[1]');
    await adapter.close();
  });

  it('uses PostgreSQL placeholders for fixture inserts', async () => {
    const calls: string[] = [];
    const client: PgClientLike = {
      async connect() {
        return;
      },
      async query(sql, params) {
        calls.push(`${sql} :: ${JSON.stringify(params)}`);

        return { rows: [], rowCount: 1 };
      },
      async end() {
        return;
      },
    };
    const adapter = createDbAdapter(
      {
        type: 'postgresql',
        host: 'db.example.test',
        name: 'app',
        ssl: false,
        isTest: true,
        writeMode: 'fixtures',
      },
      { pgClientFactory: () => client },
    );

    await adapter.ping();
    await adapter.execute('INSERT INTO posts (title) VALUES ($1)', ['hello']);

    expect(calls.some((call) => call.includes('$1'))).toBe(true);
    await adapter.close();
  });
});
