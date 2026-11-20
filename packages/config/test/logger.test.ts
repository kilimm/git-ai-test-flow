import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, maskSecret, REDACTED_VALUE } from '../src/logger.js';

class MemoryDestination extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString('utf8'));
    callback();
  }
}

describe('createLogger', () => {
  it('writes JSON logs and redacts sensitive fields', async () => {
    const destination = new MemoryDestination();
    const logger = createLogger({ level: 'info', destination });

    logger.info(
      {
        password: 'super-secret',
        nested: { token: 'token-value' },
        req: { body: { secret: 'body-secret' } },
        context: { deep: { webhookSecret: 'webhook-secret' } },
      },
      'login',
    );
    await new Promise((resolve) => setImmediate(resolve));

    const output = destination.lines.join('');

    expect(output).toContain(REDACTED_VALUE);
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('token-value');
    expect(output).not.toContain('body-secret');
    expect(output).not.toContain('webhook-secret');
  });
});

describe('maskSecret', () => {
  it('keeps a short prefix and suffix', () => {
    expect(maskSecret('sk-12345678')).toBe('sk-****5678');
  });

  it('fully masks short secrets', () => {
    expect(maskSecret('abc')).toBe('****');
  });

  it('returns an empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
  });
});
