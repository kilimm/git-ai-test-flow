import { describe, expect, it } from 'vitest';
import {
  buildCredentialAad,
  createEncryptionKey,
  decrypt,
  decryptCredential,
  encrypt,
  encryptCredential,
  EncryptionError,
} from '../src/crypto.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const keyV1 = createEncryptionKey(KEY_BASE64, 1);
const context = {
  tenantId: 'tenant-1',
  credentialId: 'credential-1',
  type: 'git',
};
const aad = buildCredentialAad(context, 1);

describe('credential encryption', () => {
  it('round trips plaintext with AAD', () => {
    const payload = encryptCredential('super-secret-token', keyV1, context);

    expect(payload.iv).toHaveLength(12);
    expect(payload.authTag).toHaveLength(16);
    expect(payload.keyVersion).toBe(1);
    expect(decryptCredential(payload, keyV1, context)).toBe('super-secret-token');
  });

  it('builds the documented AAD', () => {
    expect(aad).toBe('tenant:tenant-1|credential:credential-1|type:git|v1');
  });

  it('uses a fresh IV for each encryption', () => {
    const first = encrypt('value', keyV1, aad);
    const second = encrypt('value', keyV1, aad);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('rejects decryption with the wrong AAD', () => {
    const payload = encrypt('value', keyV1, aad);

    expect(() => decrypt(payload, keyV1, 'tenant:other')).toThrow(EncryptionError);
  });

  it('rejects decryption with the wrong key', () => {
    const payload = encrypt('value', keyV1, aad);
    const otherKey = createEncryptionKey(Buffer.alloc(32, 9).toString('base64'), 1);

    expect(() => decrypt(payload, otherKey, aad)).toThrow(EncryptionError);
  });

  it('rejects a tampered authentication tag', () => {
    const payload = encrypt('value', keyV1, aad);
    const authTag = Buffer.from(payload.authTag);
    authTag[0] = (authTag[0] ?? 0) ^ 0xff;

    expect(() => decrypt({ ...payload, authTag }, keyV1, aad)).toThrow(EncryptionError);
  });

  it('rejects a key version mismatch', () => {
    const payload = encrypt('value', keyV1, aad);
    const keyV2 = createEncryptionKey(KEY_BASE64, 2);

    expect(() => decrypt(payload, keyV2, aad)).toThrow(
      expect.objectContaining({ code: 'KEY_VERSION_MISMATCH' }),
    );
  });

  it('rejects AAD parts containing the delimiter', () => {
    expect(() => buildCredentialAad({ ...context, tenantId: 'tenant|1' }, 1)).toThrow(
      EncryptionError,
    );
  });
});

describe('createEncryptionKey', () => {
  it('rejects non-base64 keys', () => {
    expect(() => createEncryptionKey('not base64!')).toThrow(EncryptionError);
  });

  it('rejects keys with the wrong length', () => {
    expect(() => createEncryptionKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(
      EncryptionError,
    );
  });

  it('rejects invalid versions', () => {
    expect(() => createEncryptionKey(KEY_BASE64, 0)).toThrow(EncryptionError);
  });
});
