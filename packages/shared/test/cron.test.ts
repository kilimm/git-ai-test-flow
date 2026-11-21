// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { nextCronTime, parseCron } from '../src/index.js';

describe('cron parser', () => {
  it('parses lists, ranges and steps', () => {
    const parsed = parseCron('*/15 9-18 1,15 * 1-5');

    expect([...parsed.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hour.values]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect([...parsed.dayOfMonth.values]).toEqual([1, 15]);
    expect([...parsed.dayOfWeek.values]).toEqual([1, 2, 3, 4, 5]);
  });

  it('normalizes Sunday 7 to 0', () => {
    expect([...parseCron('0 0 * * 7').dayOfWeek.values]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/out of range/);
  });

  it('computes the next UTC occurrence', () => {
    const next = nextCronTime('*/15 * * * *', new Date('2026-11-21T10:07:30Z'));

    expect(next?.toISOString()).toBe('2026-11-21T10:15:00.000Z');
  });

  it('supports month/day and weekday constraints', () => {
    const next = nextCronTime('0 9 1 * *', new Date('2026-01-15T00:00:00Z'));

    expect(next?.toISOString()).toBe('2026-02-01T09:00:00.000Z');
  });

  it('returns null for impossible dates', () => {
    expect(nextCronTime('0 0 31 2 *', new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });
});
