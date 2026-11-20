// 本文件所有改动要求遵循 agent-rules 规范
import { createEncryptionKey, decryptCredential, encryptCredential } from '@gait/config';
import type { AppEnv, EncryptionKey } from '@gait/config';
import type { EncryptedSecret } from '@gait/db';

/**
 * 配置密钥的统一入口：AAD 绑定租户、资源 ID 与用途类型，
 * 即使密文被搬运到其它记录也无法解密。
 */
export class SecretCipher {
  constructor(private readonly key: EncryptionKey) {}

  encrypt(tenantId: string, resourceId: string, type: string, plaintext: string): EncryptedSecret {
    return encryptCredential(plaintext, this.key, { tenantId, credentialId: resourceId, type });
  }

  decrypt(tenantId: string, resourceId: string, type: string, payload: EncryptedSecret): string {
    return decryptCredential(
      {
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
        keyVersion: payload.keyVersion,
      },
      this.key,
      { tenantId, credentialId: resourceId, type },
    );
  }
}

export function createSecretCipher(env: AppEnv): SecretCipher {
  return new SecretCipher(createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));
}

/** API 只返回掩码；短密钥完全隐藏，长密钥仅保留少量首尾字符。 */
export function maskSecret(secret: string): string {
  const value = secret.trim();

  if (value.length === 0) {
    return '****';
  }

  if (value.startsWith('sk-') && value.length > 10) {
    return `sk-****${value.slice(-4)}`;
  }

  if (value.length <= 8) {
    return '****';
  }

  const prefixLength = value.length >= 16 ? 4 : 2;
  const suffixLength = value.length >= 16 ? 4 : 2;

  return `${value.slice(0, prefixLength)}****${value.slice(-suffixLength)}`;
}

/** Webhook URL 视作密钥：只暴露协议、主机与末 4 位，隐藏 hook token。 */
export function maskWebhookUrl(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl);
    const trimmedPath = url.pathname.replace(/\/+$/, '');
    const suffix = trimmedPath.slice(-4);

    return `${url.protocol}//${url.host}/****${suffix.length > 0 ? suffix : ''}`;
  } catch {
    return '****';
  }
}

export const SECRET_AAD_TYPE = {
  FEISHU_WEBHOOK: 'feishu_webhook_url',
  FEISHU_SIGNING_SECRET: 'feishu_sign_secret',
} as const;
