// 本文件所有改动要求遵循 agent-rules 规范
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GIT_CONNECTION_ERROR,
  classifyGitError,
  createAskPassScript,
  createGitChildEnv,
  createGitLsRemoteRunner,
  sanitizeGitMessage,
} from '../src/config/git-client.js';

describe('git error classification', () => {
  it('maps common failures to stable error codes', () => {
    expect(classifyGitError('Could not resolve host: github.com')).toBe(
      GIT_CONNECTION_ERROR.DNS_FAILURE,
    );
    expect(classifyGitError('SSL certificate problem: unable to get local issuer')).toBe(
      GIT_CONNECTION_ERROR.TLS_ERROR,
    );
    expect(classifyGitError('fatal: Authentication failed for repository')).toBe(
      GIT_CONNECTION_ERROR.AUTH_FAILED,
    );
    expect(classifyGitError('remote: Permission denied')).toBe(
      GIT_CONNECTION_ERROR.PERMISSION_DENIED,
    );
    expect(classifyGitError('remote: Repository not found.')).toBe(
      GIT_CONNECTION_ERROR.REPOSITORY_NOT_FOUND,
    );
    expect(classifyGitError('ssh: connect to host: Connection refused')).toBe(
      GIT_CONNECTION_ERROR.NETWORK_ERROR,
    );
    expect(classifyGitError('something unexpected')).toBe(GIT_CONNECTION_ERROR.UNKNOWN_ERROR);
  });

  it('redacts tokens, URL credentials and control characters', () => {
    const token = 'ghp_secret_token';
    const message = sanitizeGitMessage(
      `fatal: https://user:${token}@github.com/acme/repo ${token}${String.fromCharCode(0)}`,
      token,
    );

    expect(message).not.toContain(token);
    expect(message).not.toContain(String.fromCharCode(0));
    expect(message).toContain('https://****@github.com/acme/repo');
  });

  it('truncates very long messages', () => {
    const message = sanitizeGitMessage('x'.repeat(500));

    expect(message.length).toBeLessThanOrEqual(301);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('git askpass environment', () => {
  it('writes a script that reads the token from the environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gait-git-askpass-'));

    try {
      const path = createAskPassScript(directory);
      const content = readFileSync(path, 'utf8');

      expect(path).toMatch(/askpass\.(sh|cmd)$/);
      expect(content).toContain('GAIT_GIT_TOKEN');
      expect(content).toContain('GAIT_GIT_USERNAME');
      expect(content).not.toContain('ghp_');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not inherit platform secrets and disables terminal prompts', () => {
    const previousKey = process.env.ENCRYPTION_KEY;
    const previousSecret = process.env.SESSION_SECRET;
    process.env.ENCRYPTION_KEY = 'platform-key';
    process.env.SESSION_SECRET = 'session-secret';

    try {
      const env = createGitChildEnv('/tmp/askpass', 'bot', 'token');

      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.SESSION_SECRET).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GIT_ASKPASS).toBe('/tmp/askpass');
      expect(env.GAIT_GIT_USERNAME).toBe('bot');
      expect(env.GAIT_GIT_TOKEN).toBe('token');
    } finally {
      if (previousKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previousKey;
      }

      if (previousSecret === undefined) {
        delete process.env.SESSION_SECRET;
      } else {
        process.env.SESSION_SECRET = previousSecret;
      }
    }
  });
});

describe('git ls-remote runner', () => {
  it('connects to a local bare repository and reports failures', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gait-git-repo-'));

    try {
      execFileSync('git', ['init', '--bare', directory], { stdio: 'ignore' });
      const runner = createGitLsRemoteRunner();
      const success = await runner({
        repoUrl: pathToFileURL(directory).toString(),
        timeoutMs: 10_000,
      });
      expect(success.ok).toBe(true);
      expect(success.code).toBe(GIT_CONNECTION_ERROR.OK);
      expect(success.durationMs).toBeGreaterThanOrEqual(0);

      const missing = await runner({
        repoUrl: pathToFileURL(join(directory, 'missing.git')).toString(),
        token: 'ghp_never_printed',
        timeoutMs: 10_000,
      });
      expect(missing.ok).toBe(false);
      expect(missing.message).not.toContain('ghp_never_printed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
