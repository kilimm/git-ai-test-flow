// 本文件所有改动要求遵循 agent-rules 规范
import { interpolateVariables } from '../steps/variables.js';
import type { StepRuntime } from './types.js';

export function readRootPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;

  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (/^\d+$/.test(segment)) {
      current = Array.isArray(current) ? current[Number(segment)] : undefined;
    } else if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return current;
}

/** 运行时变量插值；未解析的占位符保持原样，由步骤自行报错。 */
export function resolveText(runtime: StepRuntime, text: string): string {
  return interpolateVariables(text, (root, path) => {
    const values = runtime.variables[root as keyof StepRuntime['variables']];

    return readRootPath(values, path);
  });
}

function writePath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;

  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) {
      current[segment] = value;
      return;
    }

    const next = current[segment];

    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }
}

export function setVariable(runtime: StepRuntime, name: string, value: unknown): void {
  const segments = name.split('.').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return;
  }

  writePath(runtime.variables.var, segments, value);
}

/** 每步执行后写入 steps.N.data，供后续步骤引用。 */
export function setStepData(
  runtime: StepRuntime,
  index: number,
  status: string,
  data: unknown,
): void {
  runtime.variables.steps[String(index)] = {
    status,
    data,
  };
}
