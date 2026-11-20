import { randomBytes } from 'node:crypto';

const MAX_TIMESTAMP_MS = 0xffffffffffff;

export function uuidv7(timestampMs: number = Date.now()): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_TIMESTAMP_MS) {
    throw new RangeError('UUIDv7 timestamp must be a non-negative 48-bit integer');
  }

  const bytes = randomBytes(16);
  let remaining = BigInt(timestampMs);

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
