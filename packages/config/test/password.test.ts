// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  passwordHashNeedsRehash,
  PASSWORD_HASH_OPTIONS,
  verifyPassword,
} from '../src/password.js';

describe('password hashing', () => {
  it('hashes with argon2id and verifies the password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
    expect(PASSWORD_HASH_OPTIONS.memoryCost).toBe(19_456);
  });

  it('rejects empty passwords and malformed hashes', async () => {
    expect(() => hashPassword('')).toThrow(RangeError);
    await expect(verifyPassword('not-a-hash', 'password')).resolves.toBe(false);
    await expect(verifyPassword('$argon2id$garbage', 'password')).resolves.toBe(false);
  });

  it('detects parameters that need rehashing', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(passwordHashNeedsRehash(hash)).toBe(false);
    expect(passwordHashNeedsRehash('$argon2id$garbage')).toBe(true);
  });
});
