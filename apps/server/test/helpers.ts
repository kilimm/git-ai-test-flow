// 本文件所有改动要求遵循 agent-rules 规范
import { loadEnv } from '@gait/config';
import type { AppEnv } from '@gait/config';

export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export function createTestEnv(overrides: Record<string, string | undefined> = {}): AppEnv {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ...overrides,
  });
}
