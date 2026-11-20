// 本文件所有改动要求遵循 agent-rules 规范

const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const VARIABLE_NAME = /^(env|fixture|secret|var|steps)(\.[A-Za-z0-9_-]+|\[\d+\])+$/;

export interface VariableReference {
  raw: string;
  name: string;
}

export function findVariableReferences(text: string): VariableReference[] {
  const references: VariableReference[] = [];

  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]?.trim() ?? '';
    references.push({ raw: match[0], name });
  }

  return references;
}

/** 只校验语法与根命名空间；不解析真实密钥值。 */
export function validateVariableReferences(text: string): string[] {
  const issues: string[] = [];
  const stripped = text.replace(VARIABLE_PATTERN, '');

  if (stripped.includes('{{') || stripped.includes('}}')) {
    issues.push('Contains malformed variable interpolation braces');
  }

  for (const reference of findVariableReferences(text)) {
    if (!VARIABLE_NAME.test(reference.name)) {
      issues.push(`Unknown variable reference: ${reference.raw}`);
    }
  }

  return issues;
}

function readPath(value: unknown, path: string[]): unknown {
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

export type VariableResolver = (root: string, path: string[]) => unknown;

/**
 * 运行时插值：密钥由调用方按需注入，返回值不应写入日志。
 * 未知变量保留原占位符，交由执行器报告。
 */
export function interpolateVariables(text: string, resolver: VariableResolver): string {
  return text.replace(VARIABLE_PATTERN, (raw, expression: string) => {
    const [root = '', ...path] = expression.trim().split('.');

    if (!VARIABLE_NAME.test(expression.trim())) {
      return raw;
    }

    const value = resolver(root, path);

    if (value === undefined || value === null) {
      return raw;
    }

    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function resolveFromRecord(text: string, values: Readonly<Record<string, unknown>>): string {
  return interpolateVariables(text, (root, path) => readPath(values[root], path));
}
