// 本文件所有改动要求遵循 agent-rules 规范
import { argon2id, hash, needsRehash, verify } from 'argon2';
import type { HashOptions } from 'argon2';

/**
 * OWASP 推荐的 argon2id 参数（19 MiB、2 次迭代、并行度 1）。
 * 参数变化通过 passwordHashNeedsRehash 检测，便于后续平滑升级。
 */
export const PASSWORD_HASH_OPTIONS: Readonly<HashOptions> = Object.freeze({
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export function hashPassword(password: string): Promise<string> {
  if (password.length === 0) {
    throw new RangeError('Password must not be empty');
  }

  return hash(password, PASSWORD_HASH_OPTIONS);
}

/** 校验失败（格式非法或密码错误）统一返回 false，不泄漏内部原因。 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (!passwordHash.startsWith('$argon2')) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function passwordHashNeedsRehash(passwordHash: string): boolean {
  try {
    return needsRehash(passwordHash, PASSWORD_HASH_OPTIONS);
  } catch {
    return true;
  }
}
