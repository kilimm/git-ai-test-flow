import { z } from 'zod';
import { createEncryptionKey } from './crypto.js';

const encryptionKeySchema = z.string().refine(
  (value) => {
    try {
      createEncryptionKey(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'ENCRYPTION_KEY must be a base64-encoded 32-byte key' },
);

const publicBaseUrlSchema = z.url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'PUBLIC_BASE_URL must use http or https' },
);

const ssrfAllowlistSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().min(1).default('./data'),
  DATABASE_PATH: z.string().min(1).default('./data/app.db'),
  CHECKPOINT_DB_PATH: z.string().min(1).default('./data/checkpoints/checkpoints.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ENCRYPTION_KEY: encryptionKeySchema,
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_BASE_URL: publicBaseUrlSchema,
  SSRF_ALLOWLIST: ssrfAllowlistSchema,
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface EnvIssue {
  path: string;
  message: string;
  code: string;
}

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      `Invalid environment configuration: ${issues
        .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      })),
    );
  }

  return result.data;
}
