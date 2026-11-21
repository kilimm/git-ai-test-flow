// 本文件所有改动要求遵循 agent-rules 规范

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(value: string, min: number, max: number, index: number): CronField {
  const values = new Set<number>();
  const wildcard = value === '*' || value.startsWith('*/');

  for (const part of value.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);

    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Cron field ${index + 1} has an invalid step`);
    }

    let start: number;
    let end: number;

    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [left, right] = range.split('-');
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(range);
      end = start;
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Cron field ${index + 1} is out of range`);
    }

    for (let current = start; current <= end; current += step) {
      values.add(current);
    }
  }

  if (index === 4 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  if (values.size === 0) {
    throw new Error(`Cron field ${index + 1} is empty`);
  }

  return { values, wildcard };
}

/** 解析标准 5 段 cron；不支持秒字段与 Quartz 扩展。 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error('Cron expression must contain exactly 5 fields');
  }

  return {
    minute: parseField(fields[0] ?? '', FIELD_RANGES[0][0], FIELD_RANGES[0][1], 0),
    hour: parseField(fields[1] ?? '', FIELD_RANGES[1][0], FIELD_RANGES[1][1], 1),
    dayOfMonth: parseField(fields[2] ?? '', FIELD_RANGES[2][0], FIELD_RANGES[2][1], 2),
    month: parseField(fields[3] ?? '', FIELD_RANGES[3][0], FIELD_RANGES[3][1], 3),
    dayOfWeek: parseField(fields[4] ?? '', FIELD_RANGES[4][0], FIELD_RANGES[4][1], 4),
  };
}

function matchesDay(parsed: ParsedCron, date: Date): boolean {
  const domMatches = parsed.dayOfMonth.values.has(date.getUTCDate());
  const dowMatches = parsed.dayOfWeek.values.has(date.getUTCDay());

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    return true;
  }

  if (parsed.dayOfMonth.wildcard) {
    return dowMatches;
  }

  if (parsed.dayOfWeek.wildcard) {
    return domMatches;
  }

  return domMatches || dowMatches;
}

/**
 * 计算下一次触发时间（UTC），从 after 的下一分钟开始搜索。
 * 最多搜索 366 天；返回 null 表示表达式不可达（例如 2 月 31 日）。
 */
export function nextCronTime(expression: string, after: Date = new Date()): Date | null {
  const parsed = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60 * 1_000;

  while (candidate.getTime() <= limit) {
    if (
      parsed.minute.values.has(candidate.getUTCMinutes()) &&
      parsed.hour.values.has(candidate.getUTCHours()) &&
      parsed.month.values.has(candidate.getUTCMonth() + 1) &&
      matchesDay(parsed, candidate)
    ) {
      return candidate;
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return null;
}
