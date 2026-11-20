// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { normalize, sep } from 'node:path';
import { join } from 'node:path';
import { repoRelativePathIssues } from '@gait/shared';
import { StepExecutionError } from './types.js';

/** 校验并解析 Suite 内绝对路径；不做存在性检查。 */
export function resolveSuitePath(suiteRoot: string, relativePath: string): string {
  const issues = repoRelativePathIssues(relativePath);

  if (issues.length > 0) {
    throw new StepExecutionError('SUITE_PATH_INVALID', issues.join('; '));
  }

  const absolute = normalize(join(suiteRoot, relativePath));

  if (absolute !== suiteRoot && !absolute.startsWith(`${suiteRoot}${sep}`)) {
    throw new StepExecutionError('SUITE_PATH_INVALID', 'File path escapes suite root');
  }

  return absolute;
}

/** 只允许读取 Suite 仓库内文件，拒绝路径穿越与符号链接逃逸。 */
export function readSuiteFile(suiteRoot: string, relativePath: string): string {
  const absolute = resolveSuitePath(suiteRoot, relativePath);

  if (!existsSync(absolute)) {
    throw new StepExecutionError('SUITE_FILE_MISSING', `Suite file not found: ${relativePath}`);
  }

  try {
    const realRoot = realpathSync(suiteRoot);
    const realFile = realpathSync(absolute);

    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
      throw new StepExecutionError('SUITE_PATH_INVALID', 'File resolves outside suite root');
    }
  } catch (error) {
    if (error instanceof StepExecutionError) {
      throw error;
    }

    throw new StepExecutionError(
      'SUITE_FILE_MISSING',
      `Unable to resolve suite file: ${relativePath}`,
      'error',
      { cause: error },
    );
  }

  return readFileSync(absolute, 'utf8');
}

/** 解析 JSON Schema 引用：支持内联 JSON 与 Suite `schemas/` 下的文件。 */
export function resolveJsonSchema(suiteRoot: string, reference: string): unknown {
  const trimmed = reference.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new StepExecutionError(
        'JSON_SCHEMA_INVALID',
        'Inline JSON Schema is not valid JSON',
        'failed',
        {
          cause: error,
        },
      );
    }
  }

  const relativePath = trimmed.includes('/') ? trimmed : `schemas/${trimmed}`;
  const source = readSuiteFile(suiteRoot, relativePath);

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new StepExecutionError(
      'JSON_SCHEMA_INVALID',
      `JSON Schema is not valid JSON: ${relativePath}`,
      'failed',
      { cause: error },
    );
  }
}
