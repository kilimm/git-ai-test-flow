import { z } from 'zod';
import { createEncryptionKey } from './crypto.js';
import { databaseIdentity } from './database-url.js';

export const DEFAULT_DATA_DIR = './data';
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/gait';
export const DEFAULT_CHECKPOINT_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/gait_checkpoints';

const postgresUrlSchema = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'postgres:' || protocol === 'postgresql:';
    } catch {
      return false;
    }
  },
  { message: 'must be a postgres:// or postgresql:// connection URL' },
);

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

/** 容器/CI 常把未设置变量传成空串；空串视同未设置。 */
function optionalString(min: number, max: number): z.ZodType<string | undefined> {
  return z
    .preprocess((value) => (value === '' ? undefined : value), z.string().trim().min(min).max(max))
    .optional();
}

function optionalUrl(): z.ZodType<string | undefined> {
  return z.preprocess((value) => (value === '' ? undefined : value), z.url()).optional();
}

const ssrfAllowlistSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().min(1).default(DEFAULT_DATA_DIR),
    DATABASE_URL: postgresUrlSchema.default(DEFAULT_DATABASE_URL),
    CHECKPOINT_DATABASE_URL: postgresUrlSchema.default(DEFAULT_CHECKPOINT_DATABASE_URL),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ENCRYPTION_KEY: encryptionKeySchema,
    ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    PUBLIC_BASE_URL: publicBaseUrlSchema,
    /** OIDC 回调基地址；默认 PUBLIC_BASE_URL + /api/v1（同源反向代理场景）。 */
    SSO_CALLBACK_BASE_URL: optionalUrl(),
    SSRF_ALLOWLIST: ssrfAllowlistSchema,
    ARTIFACT_STORAGE: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: optionalUrl(),
    S3_BUCKET: optionalString(1, 255),
    S3_REGION: z.string().trim().min(1).max(64).default('us-east-1'),
    S3_ACCESS_KEY_ID: optionalString(1, 255),
    S3_SECRET_ACCESS_KEY: optionalString(1, 1_024),
    S3_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
    /** 与平台 Runner 注册表中的 name 对应；未设置时只写 worker_heartbeats。 */
    RUNNER_NAME: optionalString(1, 100),
    RUNNER_MODE: z.enum(['local', 'container']).default('local'),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
    WORKER_LEASE_MS: z.coerce.number().int().min(1_000).default(30_000),
    WORKER_HEARTBEAT_MS: z.coerce.number().int().min(100).default(10_000),
  })
  .superRefine((value, context) => {
    const appIdentity = databaseIdentity(value.DATABASE_URL);
    const checkpointIdentity = databaseIdentity(value.CHECKPOINT_DATABASE_URL);

    if (value.WORKER_HEARTBEAT_MS >= value.WORKER_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_HEARTBEAT_MS'],
        message: 'WORKER_HEARTBEAT_MS must be less than WORKER_LEASE_MS',
      });
    }

    // 应用库与 LangGraph checkpoint 必须分离，避免框架表污染业务库与锁竞争。
    // 比较 host/port/database（缺省端口按 5432），而不是完整连接串。
    if (
      value.DATABASE_URL === value.CHECKPOINT_DATABASE_URL ||
      (appIdentity !== null && appIdentity === checkpointIdentity)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['CHECKPOINT_DATABASE_URL'],
        message: 'CHECKPOINT_DATABASE_URL must differ from DATABASE_URL',
      });
    }
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
