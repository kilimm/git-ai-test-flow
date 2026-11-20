// 本文件所有改动要求遵循 agent-rules 规范

const SENSITIVE_KEY =
  /(password|passwd|secret|token|authorization|cookie|api[-_]?key|credential|session[-_]?id)/i;
const SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/gi,
  /(Basic\s+)[A-Za-z0-9+/=]{10,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
];

const MASK = '****';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;

export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_KEY.test(name) ? MASK : redactText(value);
  }

  return result;
}

export function redactText(value: string): string {
  let result = value;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, (...args: unknown[]) => {
      const prefix = args[1];

      return typeof prefix === 'string' ? `${prefix}${MASK}` : MASK;
    });
  }

  return result;
}

/** 递归脱敏 JSON；限制深度与数组长度，避免超大响应拖慢存储。 */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactJson(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? MASK : redactJson(entry, depth + 1);
    }

    return result;
  }

  return value;
}

/** 解析 JSON 后脱敏，解析失败则按文本脱敏。 */
export function redactBody(bodyText: string): unknown {
  const trimmed = bodyText.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return redactJson(JSON.parse(trimmed));
    } catch {
      return redactText(bodyText);
    }
  }

  return redactText(bodyText);
}

export function truncateText(value: string, maxChars = 64 * 1024): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}
