// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DATA_DIR, DEFAULT_DATABASE_PATH } from '@gait/config';
import { backupDatabase } from '../backup.js';

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

async function main(): Promise<void> {
  const databasePath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultTarget = join(
    process.env.DATA_DIR ?? DEFAULT_DATA_DIR,
    'backups',
    `app-${stamp}.db`,
  );
  const target =
    argumentValue(process.argv.slice(2), '--out') ?? process.env.BACKUP_PATH ?? defaultTarget;
  const result = await backupDatabase({ sourcePath: databasePath, targetPath: target });

  process.stdout.write(
    `Backup written to ${result.targetPath} (${result.tables} tables, ${result.sizeBytes} bytes)\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Backup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
