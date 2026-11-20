// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SQLITE_BUSY_TIMEOUT_MS } from '../src/client.js';
import type { OpenedDatabase } from '../src/client.js';

const directories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-client-'));
  directories.push(directory);
  return join(directory, 'nested', 'app.db');
}

afterEach(() => {
  for (const database of openedDatabases.splice(0)) {
    database.close();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('openDatabase', () => {
  it('creates the parent directory and applies connection pragmas', () => {
    const path = createDatabasePath();
    const database = openDatabase({ path });
    openedDatabases.push(database);

    expect(existsSync(path)).toBe(true);
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.sqlite.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(database.sqlite.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('enforces foreign keys on every connection', () => {
    const database = openDatabase({ path: createDatabasePath() });
    openedDatabases.push(database);

    database.sqlite.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id)
      );
    `);

    expect(() =>
      database.sqlite
        .prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)')
        .run('child-1', 'missing-parent'),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('supports in-memory databases for lightweight tests', () => {
    const database = openDatabase({ path: ':memory:' });
    openedDatabases.push(database);

    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
