import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/env.js';

const VALID_ENV = {
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'http://localhost:5173',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DATA_DIR).toBe('./data');
    expect(env.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/gait');
    expect(env.CHECKPOINT_DATABASE_URL).toBe(
      'postgresql://postgres:postgres@localhost:5432/gait_checkpoints',
    );
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
    expect(env.RUNNER_CONCURRENCY).toBe(2);
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(1_000);
    expect(env.WORKER_LEASE_MS).toBe(30_000);
    expect(env.WORKER_HEARTBEAT_MS).toBe(10_000);
    expect(env.SSRF_ALLOWLIST).toEqual([]);
  });

  it('coerces numeric values and parses the SSRF allowlist', () => {
    const env = loadEnv({
      ...VALID_ENV,
      PORT: '4100',
      RUNNER_CONCURRENCY: '4',
      WORKER_POLL_INTERVAL_MS: '250',
      WORKER_LEASE_MS: '5000',
      WORKER_HEARTBEAT_MS: '1500',
      SSRF_ALLOWLIST: '127.0.0.1, 10.0.0.5 ,,',
    });

    expect(env.PORT).toBe(4100);
    expect(env.RUNNER_CONCURRENCY).toBe(4);
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(250);
    expect(env.WORKER_LEASE_MS).toBe(5000);
    expect(env.WORKER_HEARTBEAT_MS).toBe(1500);
    expect(env.SSRF_ALLOWLIST).toEqual(['127.0.0.1', '10.0.0.5']);
  });

  it('rejects a worker heartbeat that is not shorter than its lease', () => {
    expect(() =>
      loadEnv({
        ...VALID_ENV,
        WORKER_LEASE_MS: '5000',
        WORKER_HEARTBEAT_MS: '5000',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects missing required values', () => {
    expect(() => loadEnv({ ...VALID_ENV, ENCRYPTION_KEY: undefined })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...VALID_ENV, SESSION_SECRET: undefined })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...VALID_ENV, PUBLIC_BASE_URL: undefined })).toThrow(EnvValidationError);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadEnv({ ...VALID_ENV, ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow(EnvValidationError);
  });

  it('rejects non-postgres database URLs and identical databases', () => {
    expect(() => loadEnv({ ...VALID_ENV, DATABASE_URL: 'sqlite://./data/app.db' })).toThrow(
      EnvValidationError,
    );
    expect(() =>
      loadEnv({
        ...VALID_ENV,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
        CHECKPOINT_DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
      }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({
        ...VALID_ENV,
        DATABASE_URL: 'postgresql://user:pass@localhost/app',
        CHECKPOINT_DATABASE_URL: 'postgres://other:other@localhost:5432/app',
      }),
    ).toThrow(EnvValidationError);
  });

  it('rejects an invalid public base URL', () => {
    expect(() => loadEnv({ ...VALID_ENV, PUBLIC_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ ...VALID_ENV, PUBLIC_BASE_URL: 'ftp://example.com' })).toThrow(
      EnvValidationError,
    );
  });

  it('does not leak invalid secret values in the error message', () => {
    const secret = 'too-short';
    let thrown: unknown;

    try {
      loadEnv({ ...VALID_ENV, SESSION_SECRET: secret });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvValidationError);
    expect((thrown as EnvValidationError).message).not.toContain(secret);
  });
});
