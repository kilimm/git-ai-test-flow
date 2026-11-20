// 本文件所有改动要求遵循 agent-rules 规范

export type JsonPathToken = string | number;

export interface JsonPathParseResult {
  tokens: JsonPathToken[];
  issues: string[];
}

const PROPERTY_PATTERN = /^\.([A-Za-z0-9_-]+)/;
const INDEX_PATTERN = /^\[(\d+)\]/;
const MAX_PATH_LENGTH = 200;

/**
 * 受限 JSONPath：`$.data.version`、`data.version`、`data.items[0].sha`。
 * 不支持过滤表达式与递归下降，避免执行任意表达式。
 */
export function parseJsonPath(path: string): JsonPathParseResult {
  const issues: string[] = [];
  const tokens: JsonPathToken[] = [];

  if (path.length === 0) {
    issues.push('JSON path must not be empty');

    return { tokens, issues };
  }

  if (path.length > MAX_PATH_LENGTH) {
    issues.push(`JSON path must be at most ${MAX_PATH_LENGTH} characters`);

    return { tokens, issues };
  }

  let rest = path.trim();
  let allowBareFirstSegment = true;

  if (rest.startsWith('$')) {
    rest = rest.slice(1);
    allowBareFirstSegment = false;
  }

  while (rest.length > 0) {
    if (allowBareFirstSegment) {
      const rootMatch = /^([A-Za-z0-9_-]+)/.exec(rest);

      if (rootMatch === null) {
        issues.push('JSON path must start with a property or index');
        break;
      }

      tokens.push(rootMatch[1] as string);
      rest = rest.slice(rootMatch[0].length);
      allowBareFirstSegment = false;
      continue;
    }

    if (rest.startsWith('.')) {
      const match = PROPERTY_PATTERN.exec(rest);

      if (match === null) {
        issues.push('JSON path contains an invalid property segment');
        break;
      }

      tokens.push(match[1] as string);
      rest = rest.slice(match[0].length);
      continue;
    }

    if (rest.startsWith('[')) {
      const match = INDEX_PATTERN.exec(rest);

      if (match === null) {
        issues.push('JSON path contains an invalid array index');
        break;
      }

      tokens.push(Number(match[1]));
      rest = rest.slice(match[0].length);
      continue;
    }

    issues.push('JSON path must use dot or bracket notation');
    break;
  }

  return { tokens, issues };
}

export function jsonPathIssues(path: string): string[] {
  return parseJsonPath(path).issues;
}

export function readJsonPath(value: unknown, path: string): unknown {
  const { tokens, issues } = parseJsonPath(path);

  if (issues.length > 0) {
    return undefined;
  }

  let current: unknown = value;

  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Array.isArray(current)) {
        return undefined;
      }

      current = current[token];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }

      current = (current as Record<string, unknown>)[token];
    }

    if (current === undefined) {
      return undefined;
    }
  }

  return current;
}

export function readVersionString(value: unknown, path: string): string | null {
  const result = readJsonPath(value, path);

  if (typeof result === 'string') {
    const trimmed = result.trim();

    return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : null;
  }

  if (typeof result === 'number' && Number.isFinite(result)) {
    return String(result);
  }

  return null;
}
