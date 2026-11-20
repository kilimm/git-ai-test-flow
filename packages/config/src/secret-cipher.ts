// 本文件所有改动要求遵循 agent-rules 规范
import { decryptCredential, encryptCredential } from './crypto.js';
import type { EncryptedPayload, EncryptionKey } from './crypto.js';

/**
 * 配置密钥统一入口：AAD 绑定租户、资源 ID 与用途类型，
 * 即使密文被搬运到其它记录也无法解密。
 */
export class SecretCipher {
  constructor(private readonly key: EncryptionKey) {}

  encrypt(tenantId: string, resourceId: string, type: string, plaintext: string): EncryptedPayload {
    return encryptCredential(plaintext, this.key, { tenantId, credentialId: resourceId, type });
  }

  decrypt(tenantId: string, resourceId: string, type: string, payload: EncryptedPayload): string {
    return decryptCredential(payload, this.key, {
      tenantId,
      credentialId: resourceId,
      type,
    });
  }
}
