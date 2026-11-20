// 本文件所有改动要求遵循 agent-rules 规范
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GitAuth {
  username?: string | undefined;
  token?: string | undefined;
}

export interface GitRunOptions {
  cwd?: string;
  auth?: GitAuth;
  timeoutMs?: number;
  allowFailure?: boolean;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class GitCommandError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`Git command failed (${args.slice(0, 3).join(' ')} …): ${stderr.slice(0, 300)}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.args = args;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const POSIX_ASKPASS = `#!/bin/sh
case "$1" in
  *sername*) printf '%s\\n' "$GAIT_GIT_USERNAME" ;;
  *) printf '%s\\n' "$GAIT_GIT_TOKEN" ;;
esac
`;

const WINDOWS_ASKPASS = `@echo off
echo %1 | findstr /I "sername" >nul
if errorlevel 1 (echo %GAIT_GIT_TOKEN%) else (echo %GAIT_GIT_USERNAME%)
`;

function writeAskPass(directory: string): string {
  const path = join(directory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');

  writeFileSync(path, process.platform === 'win32' ? WINDOWS_ASKPASS : POSIX_ASKPASS, {
    encoding: 'utf8',
    mode: 0o700,
  });

  return path;
}

function createGitEnv(auth: GitAuth | undefined, askPassPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // 子进程不继承平台密钥与运行库路径。
  for (const key of ['ENCRYPTION_KEY', 'SESSION_SECRET', 'DATABASE_PATH', 'CHECKPOINT_DB_PATH']) {
    delete env[key];
  }

  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS_REQUIRE = 'force';
  env.GIT_ASKPASS = askPassPath;
  env.GAIT_GIT_USERNAME = auth?.username ?? 'x-access-token';
  env.GAIT_GIT_TOKEN = auth?.token ?? '';
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME ?? 'git-ai-test-flow';
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL ?? 'git-ai-test-flow@localhost';
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL;

  return env;
}

function sanitize(message: string, token: string | undefined): string {
  let value = [...message]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;

      return code >= 0x20 || character === '\n' || character === '\t';
    })
    .join('');

  if (token !== undefined && token.length > 0) {
    value = value.split(token).join('****');
  }

  return value.replace(/https?:\/\/[^@\s]+@/gi, 'https://****@').trim();
}

/** 统一 Git 子进程入口：参数数组、临时 askpass、超时与输出上限。 */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const askPassDirectory = mkdtempSync(join(tmpdir(), 'gait-git-cmd-'));
  const askPassPath = writeAskPass(askPassDirectory);
  const startedAt = Date.now();

  try {
    return await new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn('git', [...args], {
        cwd: options.cwd,
        env: createGitEnv(options.auth, askPassPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const abortHandler = (): void => {
        child.kill();
      };

      options.signal?.addEventListener('abort', abortHandler, { once: true });

      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= maxOutputBytes) {
          return current;
        }

        return (current + chunk.toString('utf8')).slice(0, maxOutputBytes);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortHandler);
        finish(() =>
          reject(new GitCommandError(args, -1, sanitize(error.message, options.auth?.token))),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortHandler);

        const durationMs = Date.now() - startedAt;
        const safeStderr = sanitize(stderr, options.auth?.token);

        if (timedOut) {
          finish(() =>
            reject(new GitCommandError(args, code ?? -1, `Git command timed out: ${safeStderr}`)),
          );

          return;
        }

        if (options.signal?.aborted === true) {
          finish(() => reject(new GitCommandError(args, code ?? -1, 'Git command aborted')));

          return;
        }

        const exitCode = code ?? -1;

        if (exitCode !== 0 && options.allowFailure !== true) {
          finish(() => reject(new GitCommandError(args, exitCode, safeStderr)));
          return;
        }

        finish(() => resolve({ stdout, stderr: safeStderr, exitCode, durationMs }));
      });
    });
  } finally {
    rmSync(askPassDirectory, { recursive: true, force: true });
  }
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
