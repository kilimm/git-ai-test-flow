// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_FILE_NAME, loadDotEnv } from '../src/dotenv.js';

const ENV_KEY = 'GAIT_DOTENV_TEST_VALUE';
const directories: string[] = [];
const originalValue = process.env[ENV_KEY];

function createWorkspace(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'gait-dotenv-'));
  const nested = join(root, 'apps', 'worker');
  mkdirSync(nested, { recursive: true });
  directories.push(root);

  return { root, nested };
}

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalValue;
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadDotEnv', () => {
  it('loads the nearest .env found from a nested directory upward', () => {
    const { root, nested } = createWorkspace();
    writeFileSync(join(root, ENV_FILE_NAME), `${ENV_KEY}=from-root\n`);

    expect(loadDotEnv(nested)).toBe(join(root, ENV_FILE_NAME));
    expect(process.env[ENV_KEY]).toBe('from-root');
  });

  it('prefers the closest .env file', () => {
    const { root, nested } = createWorkspace();
    writeFileSync(join(root, ENV_FILE_NAME), `${ENV_KEY}=from-root\n`);
    writeFileSync(join(nested, ENV_FILE_NAME), `${ENV_KEY}=from-nested\n`);

    expect(loadDotEnv(nested)).toBe(join(nested, ENV_FILE_NAME));
    expect(process.env[ENV_KEY]).toBe('from-nested');
  });

  it('keeps existing environment values over file values', () => {
    const { root, nested } = createWorkspace();
    writeFileSync(join(root, ENV_FILE_NAME), `${ENV_KEY}=from-file\n`);
    process.env[ENV_KEY] = 'from-env';

    loadDotEnv(nested);

    expect(process.env[ENV_KEY]).toBe('from-env');
  });
});
