import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type EncryptionErrorCode =
  'INVALID_KEY' | 'INVALID_PAYLOAD' | 'KEY_VERSION_MISMATCH' | 'DECRYPTION_FAILED';

export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;

  constructor(code: EncryptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptionError';
    this.code = code;
  }
}

export interface EncryptionKey {
  version: number;
  bytes: Buffer;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface CredentialAadContext {
  tenantId: string;
  credentialId: string;
  type: string;
}

export function createEncryptionKey(base64Key: string, version = 1): EncryptionKey {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new EncryptionError('INVALID_KEY', 'Encryption key version must be a positive integer');
  }

  if (!BASE64_PATTERN.test(base64Key)) {
    throw new EncryptionError('INVALID_KEY', 'Encryption key must be base64 encoded');
  }

  const bytes = Buffer.from(base64Key, 'base64');

  if (bytes.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError('INVALID_KEY', 'Encryption key must decode to 32 bytes');
  }

  return { version, bytes };
}

export function buildCredentialAad(context: CredentialAadContext, keyVersion: number): string {
  assertAadPart(context.tenantId, 'tenantId');
  assertAadPart(context.credentialId, 'credentialId');
  assertAadPart(context.type, 'type');

  return `tenant:${context.tenantId}|credential:${context.credentialId}|type:${context.type}|v${keyVersion}`;
}

export function encrypt(plaintext: string, key: EncryptionKey, aad: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    keyVersion: key.version,
  };
}

export function decrypt(payload: EncryptedPayload, key: EncryptionKey, aad: string): string {
  if (payload.keyVersion !== key.version) {
    throw new EncryptionError(
      'KEY_VERSION_MISMATCH',
      'Encryption key version does not match payload',
    );
  }

  if (payload.iv.length !== IV_LENGTH_BYTES || payload.authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new EncryptionError('INVALID_PAYLOAD', 'Encrypted payload has an invalid IV or auth tag');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, payload.iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return plaintext;
  } catch (error) {
    throw new EncryptionError('DECRYPTION_FAILED', 'Unable to decrypt payload', { cause: error });
  }
}

export function encryptCredential(
  plaintext: string,
  key: EncryptionKey,
  context: CredentialAadContext,
): EncryptedPayload {
  return encrypt(plaintext, key, buildCredentialAad(context, key.version));
}

export function decryptCredential(
  payload: EncryptedPayload,
  key: EncryptionKey,
  context: CredentialAadContext,
): string {
  return decrypt(payload, key, buildCredentialAad(context, payload.keyVersion));
}

function assertAadPart(value: string, name: string): void {
  if (value.length === 0 || value.includes('|')) {
    throw new EncryptionError('INVALID_PAYLOAD', `Invalid ${name} for AAD`);
  }
}
