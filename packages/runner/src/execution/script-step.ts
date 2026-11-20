// 本文件所有改动要求遵循 agent-rules 规范
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { RUN_LIMITS } from '@gait/shared';
import { redactText } from '../artifacts/redaction.js';
import { resolveSuitePath } from './suite-files.js';
import { setStepData } from './variables.js';
import { StepExecutionError } from './types.js';
import type { StepRuntime } from './types.js';
import type { StepDefinitionInput } from '../steps/registry.js';

export interface ScriptStepResult {
  output: Record<string, unknown>;
}

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 200 * 1024;

function scriptPath(suiteRoot: string, definition: StepDefinitionInput): string {
  const candidates: string[] = [];

  if (definition.script !== undefined && definition.script.length > 0) {
    candidates.push(definition.script);
  } else {
    candidates.push(
      `scripts/${definition.name}.mjs`,
      `scripts/${definition.name}.js`,
      `templates/${definition.name}.mjs`,
      `templates/${definition.name}.js`,
    );
  }

  for (const candidate of candidates) {
    if (!/\.(mjs|js)$/.test(candidate)) {
      throw new StepExecutionError(
        'SCRIPT_PATH_INVALID',
        'Script steps must reference an .mjs or .js file',
        'error',
      );
    }

    const absolute = resolveSuitePath(suiteRoot, candidate);

    if (existsSync(absolute)) {
      const realRoot = realpathSync(suiteRoot);
      const realFile = realpathSync(absolute);

      if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
        throw new StepExecutionError(
          'SCRIPT_PATH_INVALID',
          'Script resolves outside the suite root',
          'error',
        );
      }

      return absolute;
    }
  }

  throw new StepExecutionError(
    'SCRIPT_FILE_MISSING',
    `No suite script found for step ${definition.name}`,
    'error',
  );
}

/** 脚本环境白名单：不继承平台密钥、数据库路径或租户数据。 */
function scriptEnv(namespace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    GAIT_RUN_NAMESPACE: namespace,
    GAIT_SCRIPT_EXECUTION: '1',
  };

  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });

    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/**
 * 执行 Suite 仓库中受版本管理的脚本：
 * - 只允许 .mjs/.js，路径限制在 Suite 根目录；
 * - 子进程超时、取消时终止进程树；
 * - 环境变量白名单，不传入 secret；
 * - stdout 必须是可选 JSON，非零退出归为执行错误。
 */
export async function runSuiteScript(
  runtime: StepRuntime,
  definition: StepDefinitionInput,
  stepIndex: number,
  stepText: string,
  params: readonly string[],
): Promise<ScriptStepResult> {
  const absolute = scriptPath(runtime.suiteRoot, definition);
  const timeoutMs = RUN_LIMITS.SCRIPT_TIMEOUT_MS;
  const input = JSON.stringify({
    step: stepText,
    params,
    case: {
      featurePath: runtime.identity.featurePath,
      scenarioName: runtime.identity.scenarioName,
      caseKey: runtime.identity.caseKey,
      tags: runtime.identity.tags,
    },
    env: {
      apiBaseUrl: runtime.environment.apiBaseUrl,
      webBaseUrl: runtime.environment.webBaseUrl,
    },
    run: { namespace: runtime.identity.namespace },
    variables: {
      env: runtime.variables.env,
      fixture: runtime.variables.fixture,
      var: runtime.variables.var,
    },
  });

  return new Promise<ScriptStepResult>((resolve, reject) => {
    const child = spawn(process.execPath, [absolute], {
      cwd: runtime.suiteRoot,
      env: scriptEnv(runtime.identity.namespace),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const timer: { timeout?: NodeJS.Timeout } = {};
    const signal = runtime.signal;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer.timeout !== undefined) {
        clearTimeout(timer.timeout);
      }

      signal?.removeEventListener('abort', onAbort);
      callback();
    };

    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    timer.timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_STDOUT_BYTES);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_STDERR_BYTES);
      }
    });
    child.on('error', (error) => {
      finish(() =>
        reject(
          new StepExecutionError(
            'SCRIPT_FAILED',
            `Failed to start suite script: ${error.message}`,
            'error',
            {
              cause: error,
            },
          ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        const safeStderr = redactText(stderr).slice(0, 2_000);

        if (aborted || signal?.aborted === true) {
          reject(new StepExecutionError('RUN_CANCELED', 'Script step canceled', 'error'));
          return;
        }

        if (timedOut) {
          reject(
            new StepExecutionError(
              'SCRIPT_TIMEOUT',
              `Suite script timed out after ${timeoutMs}ms`,
              'error',
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new StepExecutionError(
              'SCRIPT_FAILED',
              `Suite script exited with code ${code ?? -1}: ${safeStderr}`,
              'error',
            ),
          );
          return;
        }

        let parsed: unknown = null;

        if (stdout.trim().length > 0) {
          try {
            parsed = JSON.parse(stdout.slice(0, MAX_STDOUT_BYTES));
          } catch {
            parsed = redactText(stdout).slice(0, 4_000);
          }
        }

        setStepData(runtime, stepIndex, 'passed', parsed);
        resolve({
          output: {
            script: definition.name,
            result: parsed,
          },
        });
      });
    });

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}
