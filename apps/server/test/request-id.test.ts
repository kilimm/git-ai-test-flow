// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../src/request-id.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('reuses a well-formed incoming request id', () => {
    expect(resolveRequestId('req_01hzx-abc.123')).toBe('req_01hzx-abc.123');
  });

  it('uses the first value when the header repeats', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  it('generates a uuid v7 for missing or unsafe request ids', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_V7_PATTERN);
    expect(resolveRequestId([])).toMatch(UUID_V7_PATTERN);

    for (const candidate of ['', 'bad id', '<script>', 'x'.repeat(129)]) {
      expect(resolveRequestId(candidate)).toMatch(UUID_V7_PATTERN);
    }
  });
});
