// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
}

export interface OpenedDatabase {
  sqlite: Database.Database;
  db: AppDatabase;
  close(): void;
}

export interface ConfigureConnectionOptions {
  readonly?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const sqlite = new Database(options.path, {
    readonly: options.readonly === true,
    fileMustExist: options.fileMustExist === true,
  });

  try {
    configureConnection(sqlite, { readonly: options.readonly === true });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}

export function configureConnection(
  sqlite: Database.Database,
  options: ConfigureConnectionOptions = {},
): void {
  if (options.readonly !== true) {
    const journalMode = sqlite.pragma('journal_mode = WAL', { simple: true });

    if (journalMode !== 'wal' && journalMode !== 'memory') {
      throw new Error(`Unable to enable SQLite WAL mode (got ${String(journalMode)})`);
    }

    sqlite.pragma('synchronous = NORMAL');
  }

  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}
