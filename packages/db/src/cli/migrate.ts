// 本文件所有改动要求遵循 agent-rules 规范
import { DEFAULT_DATABASE_URL, loadDotEnv } from '@gait/config';
import { maskDatabaseUrl } from '../backup.js';
import { openDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';

loadDotEnv();

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const database = openDatabase({ url: databaseUrl });

  try {
    await runMigrations(database);
    process.stdout.write(`Applied migrations to ${maskDatabaseUrl(databaseUrl)}\n`);
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
