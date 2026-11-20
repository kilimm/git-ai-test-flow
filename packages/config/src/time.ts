export function nowMs(): number {
  return Date.now();
}

export function toIsoUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function nowIsoUtc(): string {
  return toIsoUtc(nowMs());
}
