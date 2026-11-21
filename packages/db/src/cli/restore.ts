// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { DEFAULT_DATABASE_PATH } from '@gait/config';
import { restoreDatabase } from '../backup.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

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

function main(): void {
  const argv = process.argv.slice(2);
  const backupPath = argumentValue(argv, '--from');

  if (backupPath === undefined) {
    throw new Error('Usage: pnpm db:restore --from <backup.db> --confirm');
  }

  const databasePath =
    argumentValue(argv, '--database') ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  const result = restoreDatabase({
    backupPath,
    targetPath: databasePath,
    confirm: argv.includes('--confirm'),
  });

  process.stdout.write(
    `Restored ${databasePath} from ${backupPath} (${result.tables} tables). Stop API/Worker before restarting.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Restore failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
