// 本文件所有改动要求遵循 agent-rules 规范
import { DEFAULT_DATABASE_URL, loadDotEnv } from '@gait/config';
import { maskDatabaseUrl, restoreDatabase } from '../backup.js';

loadDotEnv();

function argumentValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];

  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const backupPath = argumentValue(argv, '--from');

  if (backupPath === undefined) {
    throw new Error('Usage: pnpm db:restore --from <backup.dump> --confirm');
  }

  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const result = await restoreDatabase({
    backupPath,
    databaseUrl,
    confirm: argv.includes('--confirm'),
  });

  process.stdout.write(
    `Restored ${maskDatabaseUrl(databaseUrl)} from ${backupPath} (${result.tables} tables). Stop API/Worker before restarting.\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Restore failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
