import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';
import type { AppEnv } from './env.js';

export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_LOG_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'dsn',
  'apiKey',
  'api_key',
  'webhookSecret',
  'webhookUrl',
  'connectionString',
  'databaseUrl',
  'sessionSecret',
  'privateKey',
  'encryptionKey',
] as const;

const REDACT_MAX_DEPTH = 3;

function buildRedactPaths(keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const paths = [key];
    let prefix = '';

    for (let depth = 0; depth < REDACT_MAX_DEPTH; depth += 1) {
      prefix = prefix === '' ? '*' : `${prefix}.*`;
      paths.push(`${prefix}.${key}`);
    }

    return paths;
  });
}

export const LOG_REDACT_PATHS: readonly string[] = buildRedactPaths(SENSITIVE_LOG_KEYS);

export interface CreateLoggerOptions {
  level: AppEnv['LOG_LEVEL'];
  name?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    name: options.name ?? 'gait',
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: REDACTED_VALUE,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}

export function maskSecret(secret: string, prefixLength = 3, suffixLength = 4): string {
  if (secret.length === 0) {
    return '';
  }

  if (secret.length <= prefixLength + suffixLength) {
    return '****';
  }

  return `${secret.slice(0, prefixLength)}****${secret.slice(-suffixLength)}`;
}
