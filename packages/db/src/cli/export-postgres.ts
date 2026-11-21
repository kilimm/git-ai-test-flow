// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_DATABASE_PATH } from '@gait/config';
import { exportPostgresSql } from '../postgres-export.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const out = outIndex === -1 ? null : argv[outIndex + 1];
const source = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

if (out === null || out === undefined) {
  process.stderr.write('Usage: pnpm db:export:postgres --out <schema.sql> [--data]\n');
  process.exitCode = 1;
} else {
  try {
    const sql = exportPostgresSql({
      sourcePath: source,
      includeData: argv.includes('--data'),
    });

    writeFileSync(resolve(out), sql, 'utf8');
    process.stdout.write(`PostgreSQL schema exported to ${resolve(out)}\n`);
  } catch (error) {
    process.stderr.write(
      `Export failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
