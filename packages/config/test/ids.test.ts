import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TIMESTAMP_MS = 0xffffffffffff;

describe('uuidv7', () => {
  it('generates RFC 9562 version 7 identifiers', () => {
    expect(uuidv7()).toMatch(UUID_V7_PATTERN);
  });

  it('encodes the timestamp in the first 48 bits', () => {
    expect(uuidv7(0x0123456789ab).startsWith('01234567-89ab-7')).toBe(true);
  });

  it('generates unique identifiers', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));

    expect(ids.size).toBe(1000);
  });

  it('sorts identifiers by timestamp across milliseconds', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);

    expect(earlier < later).toBe(true);
  });

  it('rejects out-of-range timestamps', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(MAX_TIMESTAMP_MS + 1)).toThrow(RangeError);
  });
});
