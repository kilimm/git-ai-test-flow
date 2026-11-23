// 本文件所有改动要求遵循 agent-rules 规范
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_CONNECTION_ERROR = {
  OK: 'OK',
  DNS_FAILURE: 'DNS_FAILURE',
  TLS_ERROR: 'TLS_ERROR',
  AUTH_FAILED: 'AUTH_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  REPOSITORY_NOT_FOUND: 'REPOSITORY_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type GitConnectionErrorCode =
  (typeof GIT_CONNECTION_ERROR)[keyof typeof GIT_CONNECTION_ERROR];

export interface GitConnectionResult {
  ok: boolean;
  code: GitConnectionErrorCode;
  message: string;
  durationMs: number;
}

export interface GitLsRemoteInput {
  repoUrl: string;
  username?: string | undefined;
  token?: string | undefined;
  timeoutMs?: number;
}

export type GitLsRemote = (input: GitLsRemoteInput) => Promise<GitConnectionResult>;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 300;
/** 不应被子进程继承的敏感环境变量（密钥、库连接、对象存储与超管账号）。 */
const GIT_CHILD_ENV_DENYLIST: readonly string[] = [
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'CHECKPOINT_DATABASE_URL',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'FEISHU_APP_SECRET',
];

/** 错误信息里若意外出现 token，一律替换后再返回给 API/日志。 */
export function sanitizeGitMessage(message: string, token?: string): string {
  // 去掉控制字符，避免子进程输出注入日志或响应。
  const sanitizedMessage = [...message]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 || character === '\n' || character === '\t';
    })
    .join('');
  let sanitized = sanitizedMessage.trim();

  if (token !== undefined && token.length > 0) {
    sanitized = sanitized.split(token).join('****');
  }

  sanitized = sanitized.replace(/https?:\/\/[^@\s]+@/gi, 'https://****@');

  return sanitized.length > MAX_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH)}…`
    : sanitized;
}

export function classifyGitError(output: string): GitConnectionErrorCode {
  const normalized = output.toLowerCase();

  if (
    normalized.includes('could not resolve host') ||
    normalized.includes('name or service not known') ||
    normalized.includes('temporary failure in name resolution') ||
    normalized.includes('unknown host')
  ) {
    return GIT_CONNECTION_ERROR.DNS_FAILURE;
  }

  if (
    normalized.includes('ssl certificate') ||
    normalized.includes('certificate verify failed') ||
    normalized.includes('schannel') ||
    normalized.includes('tls')
  ) {
    return GIT_CONNECTION_ERROR.TLS_ERROR;
  }

  if (
    normalized.includes('authentication failed') ||
    normalized.includes('could not read username') ||
    normalized.includes('could not read password') ||
    normalized.includes('terminal prompts disabled') ||
    normalized.includes('http basic: access denied') ||
    normalized.includes('401')
  ) {
    return GIT_CONNECTION_ERROR.AUTH_FAILED;
  }

  if (
    normalized.includes('403') ||
    normalized.includes('permission denied') ||
    normalized.includes('not authorized')
  ) {
    return GIT_CONNECTION_ERROR.PERMISSION_DENIED;
  }

  if (
    normalized.includes('repository not found') ||
    normalized.includes('repository ... not found') ||
    normalized.includes('not found') ||
    normalized.includes('404')
  ) {
    return GIT_CONNECTION_ERROR.REPOSITORY_NOT_FOUND;
  }

  if (
    normalized.includes('connection refused') ||
    normalized.includes('connection timed out') ||
    normalized.includes('network is unreachable') ||
    normalized.includes('could not connect')
  ) {
    return GIT_CONNECTION_ERROR.NETWORK_ERROR;
  }

  return GIT_CONNECTION_ERROR.UNKNOWN_ERROR;
}

const POSIX_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$GAIT_GIT_USERNAME" ;;
  *) printf '%s\\n' "$GAIT_GIT_TOKEN" ;;
esac
`;

const WINDOWS_ASKPASS_SCRIPT = `@echo off
echo %1 | findstr /I "sername" >nul
if errorlevel 1 (echo %GAIT_GIT_TOKEN%) else (echo %GAIT_GIT_USERNAME%)
`;

/** 临时 askpass 脚本只从环境变量读取 token，脚本内容与参数都不出现密钥。 */
export function createAskPassScript(directory: string): string {
  const path = join(directory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');

  writeFileSync(
    path,
    process.platform === 'win32' ? WINDOWS_ASKPASS_SCRIPT : POSIX_ASKPASS_SCRIPT,
    {
      encoding: 'utf8',
      mode: 0o700,
    },
  );

  return path;
}

export function createGitChildEnv(
  askPassPath: string,
  username: string | undefined,
  token: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Git 子进程不应继承平台密钥、数据库连接串与对象存储凭据。
  for (const name of GIT_CHILD_ENV_DENYLIST) {
    delete env[name];
  }

  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS_REQUIRE = 'force';
  env.GIT_ASKPASS = askPassPath;
  env.GAIT_GIT_USERNAME =
    username !== undefined && username.length > 0 ? username : 'x-access-token';
  env.GAIT_GIT_TOKEN = token ?? '';

  return env;
}

function firstMeaningfulLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.replace(/^remote:\s*/i, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('fatal:') && !line.startsWith('error:'))
      .at(0) ??
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(0) ??
    'Git connection failed'
  );
}

export function createGitLsRemoteRunner(): GitLsRemote {
  return async (input) => {
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const directory = mkdtempSync(join(tmpdir(), 'gait-git-'));
    let askPassPath: string;

    try {
      askPassPath = createAskPassScript(directory);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    try {
      return await new Promise<GitConnectionResult>((resolve) => {
        const child = spawn(
          'git',
          ['-c', 'credential.helper=', 'ls-remote', '--heads', input.repoUrl],
          {
            env: createGitChildEnv(askPassPath, input.username, input.token),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);

        const append = (current: string, chunk: Buffer): string => {
          if (current.length >= MAX_OUTPUT_BYTES) {
            return current;
          }

          return (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({
            ok: false,
            code: GIT_CONNECTION_ERROR.UNKNOWN_ERROR,
            message: sanitizeGitMessage(error.message, input.token),
            durationMs: Date.now() - startedAt,
          });
        });
        child.on('close', (code) => {
          clearTimeout(timer);

          if (timedOut) {
            resolve({
              ok: false,
              code: GIT_CONNECTION_ERROR.TIMEOUT,
              message: 'Git connection timed out',
              durationMs: Date.now() - startedAt,
            });

            return;
          }

          if (code === 0) {
            const refCount = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;

            resolve({
              ok: true,
              code: GIT_CONNECTION_ERROR.OK,
              message: `Git connection succeeded (${refCount} branches)`,
              durationMs: Date.now() - startedAt,
            });

            return;
          }

          const output = stderr.trim().length > 0 ? stderr : stdout;

          resolve({
            ok: false,
            code: classifyGitError(output),
            message: sanitizeGitMessage(firstMeaningfulLine(output), input.token),
            durationMs: Date.now() - startedAt,
          });
        });
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
