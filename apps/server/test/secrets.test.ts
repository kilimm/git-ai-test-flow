// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { EncryptionError, createEncryptionKey } from '@gait/config';
import {
  SECRET_AAD_TYPE,
  SecretCipher,
  maskSecret,
  maskWebhookUrl,
} from '../src/config/secrets.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

describe('secret masking', () => {
  it('never returns short secrets and only keeps a small prefix/suffix', () => {
    expect(maskSecret('')).toBe('****');
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-****mnop');
    expect(maskSecret('ghp_abcdefghijklmnopqrstuvwxyz')).toBe('ghp_****wxyz');
    expect(maskSecret('ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain(
      'abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('masks webhook tokens but keeps protocol and host visible', () => {
    const masked = maskWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456');

    expect(masked).toBe('https://open.feishu.cn/****3456');
    expect(masked).not.toContain('abcdef123456');
    expect(maskWebhookUrl('not-a-url')).toBe('****');
  });
});

describe('SecretCipher', () => {
  it('round-trips secrets and binds ciphertext to AAD context', () => {
    const cipher = new SecretCipher(createEncryptionKey(TEST_KEY, 1));
    const payload = cipher.encrypt('tenant-1', 'credential-1', 'git_pat', 'super-secret');

    expect(payload.ciphertext.toString('utf8')).not.toContain('super-secret');
    expect(payload.iv).toHaveLength(12);
    expect(payload.authTag).toHaveLength(16);
    expect(payload.keyVersion).toBe(1);
    expect(cipher.decrypt('tenant-1', 'credential-1', 'git_pat', payload)).toBe('super-secret');

    expect(() => cipher.decrypt('tenant-2', 'credential-1', 'git_pat', payload)).toThrow(
      EncryptionError,
    );
    expect(() => cipher.decrypt('tenant-1', 'credential-2', 'git_pat', payload)).toThrow(
      EncryptionError,
    );
    expect(() => cipher.decrypt('tenant-1', 'credential-1', 'llm_api_key', payload)).toThrow(
      EncryptionError,
    );
  });

  it('uses distinct IVs and supports webhook/secret AAD types', () => {
    const cipher = new SecretCipher(createEncryptionKey(TEST_KEY, 1));
    const first = cipher.encrypt('tenant-1', 'channel-1', SECRET_AAD_TYPE.FEISHU_WEBHOOK, 'url');
    const second = cipher.encrypt('tenant-1', 'channel-1', SECRET_AAD_TYPE.FEISHU_WEBHOOK, 'url');

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(cipher.decrypt('tenant-1', 'channel-1', SECRET_AAD_TYPE.FEISHU_WEBHOOK, first)).toBe(
      'url',
    );
    expect(() =>
      cipher.decrypt('tenant-1', 'channel-1', SECRET_AAD_TYPE.FEISHU_SIGNING_SECRET, first),
    ).toThrow(EncryptionError);
  });
});
