// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  redactBody,
  redactHeaders,
  redactJson,
  redactText,
  truncateText,
} from '../src/index.js';

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-artifacts-'));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('artifact redaction', () => {
  it('masks sensitive headers, keys and token-like values', () => {
    expect(
      redactHeaders({
        authorization: 'Bearer abcdefghijklmnop',
        'content-type': 'application/json',
        cookie: 'session=abc',
      }),
    ).toEqual({
      authorization: '****',
      'content-type': 'application/json',
      cookie: '****',
    });

    expect(
      redactJson({
        username: 'admin',
        password: 'p@ss',
        nested: { apiKey: 'secret', token: 'Bearer abcdefghijklmnop' },
      }),
    ).toEqual({
      username: 'admin',
      password: '****',
      nested: { apiKey: '****', token: '****' },
    });

    expect(redactText('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ****');
    expect(redactBody('{"password":"x","name":"n"}')).toEqual({ password: '****', name: 'n' });
    expect(redactBody('plain ghp_abcdefghijk')).toBe('plain ****');
    expect(truncateText('abcdef', 3)).toContain('[truncated]');
  });
});

describe('artifact store', () => {
  it('writes files, hashes content and computes retention', () => {
    const dataDir = tempDir();
    const store = new ArtifactStore({
      dataDir,
      tenantId: 'tenant-1',
      runId: 'run-1',
      now: () => 1_700_000_000_000,
    });
    const artifact = store.writeJson('api_response', 'response-1', { ok: true });
    const absolute = join(dataDir, artifact.path);
    const content = readFileSync(absolute);

    expect(existsSync(absolute)).toBe(true);
    expect(artifact.path.startsWith('artifacts/tenant-1/run-1/run/')).toBe(true);
    expect(artifact.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(artifact.size).toBe(content.byteLength);
    expect(artifact.expiresAt).toBe(1_700_000_000_000 + 180 * 24 * 60 * 60 * 1_000);
    expect(JSON.parse(content.toString('utf8'))).toEqual({ ok: true });
  });

  it('scopes artifacts to a run case and step', () => {
    const dataDir = tempDir();
    const store = new ArtifactStore({
      dataDir,
      tenantId: 'tenant-1',
      runId: 'run-1',
    }).withScope({ runCaseId: 'case-1', stepResultId: 'step-1' });
    const artifact = store.writeText('console', 'console', 'hello');

    expect(artifact.path.startsWith('artifacts/tenant-1/run-1/case-1/')).toBe(true);
    expect(artifact.dataRelativePath.startsWith('tenant-1/run-1/case-1/')).toBe(true);
  });
});
