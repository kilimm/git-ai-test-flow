// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { createCsrfToken, verifyCsrfRequest, verifyCsrfToken } from '../src/csrf.js';
import { TEST_SESSION_SECRET } from './helpers.js';

describe('csrf tokens', () => {
  it('verifies a freshly issued token', () => {
    const token = createCsrfToken(TEST_SESSION_SECRET);

    expect(token).toContain('.');
    expect(verifyCsrfToken(token, TEST_SESSION_SECRET)).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const token = createCsrfToken(TEST_SESSION_SECRET);

    expect(verifyCsrfToken(token, 'another-session-secret-0123456789')).toBe(false);
  });

  it('rejects tampered or malformed tokens', () => {
    const token = createCsrfToken(TEST_SESSION_SECRET);
    const [nonce, signature] = token.split('.');

    if (nonce === undefined || signature === undefined) {
      throw new Error('Unexpected CSRF token format');
    }

    const tamperedNonce = `${nonce.startsWith('A') ? 'B' : 'A'}${nonce.slice(1)}`;

    expect(verifyCsrfToken(`${tamperedNonce}.${signature}`, TEST_SESSION_SECRET)).toBe(false);
    expect(verifyCsrfToken('missing-separator', TEST_SESSION_SECRET)).toBe(false);
    expect(verifyCsrfToken(`${token}.extra`, TEST_SESSION_SECRET)).toBe(false);
    expect(verifyCsrfToken('', TEST_SESSION_SECRET)).toBe(false);
  });

  it('requires matching cookie and header tokens', () => {
    const token = createCsrfToken(TEST_SESSION_SECRET);

    expect(verifyCsrfRequest(TEST_SESSION_SECRET, token, token)).toBe(true);
    expect(verifyCsrfRequest(TEST_SESSION_SECRET, token, undefined)).toBe(false);
    expect(verifyCsrfRequest(TEST_SESSION_SECRET, undefined, token)).toBe(false);
    expect(
      verifyCsrfRequest(TEST_SESSION_SECRET, token, createCsrfToken(TEST_SESSION_SECRET)),
    ).toBe(false);
  });

  it('refuses to sign with an empty secret', () => {
    expect(() => createCsrfToken('')).toThrow(/secret/);
  });
});
