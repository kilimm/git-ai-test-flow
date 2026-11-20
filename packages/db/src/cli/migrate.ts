// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { DEFAULT_DATABASE_PATH } from '@gait/config';
import { openDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databasePath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
const database = openDatabase({ path: databasePath });

try {
  runMigrations(database);
  process.stdout.write(`Applied migrations to ${databasePath}\n`);
} finally {
  database.close();
}
