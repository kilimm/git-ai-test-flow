// 本文件所有改动要求遵循 agent-rules 规范
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * message-board 传输层加密协议实现（AES-256-CBC）。
 * 与 apps/message-board/server.js 保持一致：
 *   - 口令 = 服务器本地日期 + "admin"（如 2026-11-24admin）
 *   - KDF = PBKDF2-HMAC-SHA256，迭代 20000，输出 32 字节
 *   - AES-256-CBC + PKCS7，随机 16B salt + 16B IV
 *   - 密文包 { v:2, salt(b64), iv(b64), ct(b64) }
 *
 * 注意：口令里的日期必须与被测服务所在时区的“今天”一致。测试与被测服务同机部署时，
 * 使用本机本地日期即可；若跨时区需由上层显式传入 dateOverride。
 */

const PBKDF2_ITER = 20_000;
const KEY_LEN = 32;
const ALGO = 'aes-256-cbc';

export interface EncryptedEnvelope {
  v: 2;
  salt: string;
  iv: string;
  ct: string;
}

function localDateStr(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function passphrase(dateOverride?: string): string {
  const date = dateOverride !== undefined && dateOverride.length > 0 ? dateOverride : localDateStr(new Date());
  return `${date}admin`;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

/** 加密任意可 JSON 序列化对象为密文包。 */
export function encryptPayload(obj: unknown, dateOverride?: string): EncryptedEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = deriveKey(passphrase(dateOverride), salt);
  const cipher = createCipheriv(ALGO, key, iv);
  const out = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')),
    cipher.final(),
  ]);

  return {
    v: 2,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: out.toString('base64'),
  };
}

/** 解密密文包为对象。 */
export function decryptPayload(envelope: unknown, dateOverride?: string): unknown {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('malformed-envelope');
  }

  const e = envelope as Record<string, unknown>;

  if (e.v !== 2 || typeof e.salt !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string') {
    throw new Error('malformed-envelope');
  }

  const salt = Buffer.from(e.salt, 'base64');
  const iv = Buffer.from(e.iv, 'base64');
  const ct = Buffer.from(e.ct, 'base64');
  const key = deriveKey(passphrase(dateOverride), salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);

  return JSON.parse(out.toString('utf8'));
}
