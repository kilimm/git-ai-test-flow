import { describe, expect, it } from 'vitest';
import { nowIsoUtc, nowMs, toIsoUtc } from '../src/time.js';

describe('time utilities', () => {
  it('formats the epoch as ISO UTC', () => {
    expect(toIsoUtc(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns current time as a millisecond timestamp', () => {
    expect(Number.isSafeInteger(nowMs())).toBe(true);
  });

  it('returns current time in ISO UTC', () => {
    expect(nowIsoUtc()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
