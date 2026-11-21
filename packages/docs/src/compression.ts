// 本文件所有改动要求遵循 agent-rules 规范
import { DOC_COMPRESSION, estimateTokens } from '@gait/shared';
import type { DocCommitEntry, DocRollup } from '@gait/shared';

interface Group {
  tier: DocRollup['tier'];
  entries: DocCommitEntry[];
  periodStart: number;
  periodEnd: number;
}

function newestFirst(entries: readonly DocCommitEntry[]): DocCommitEntry[] {
  return [...entries].sort((left, right) => right.committedAt - left.committedAt);
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }

  const lines = text.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const candidate = [...kept, line].join('\n');

    if (estimateTokens(candidate) > maxTokens) {
      break;
    }

    kept.push(line);
  }

  return kept.join('\n').slice(0, 12_000);
}

function groupSequential(entries: readonly DocCommitEntry[], size: number): Group[] {
  const groups: Group[] = [];

  for (let index = 0; index < entries.length; index += size) {
    const chunk = entries.slice(index, index + size);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    if (first === undefined || last === undefined) {
      continue;
    }

    groups.push({
      tier: 'T1',
      entries: chunk,
      periodStart: Math.min(...chunk.map((entry) => entry.committedAt)),
      periodEnd: Math.max(...chunk.map((entry) => entry.committedAt)),
    });
  }

  return groups;
}

function groupByPeriod(
  entries: readonly DocCommitEntry[],
  tier: DocRollup['tier'],
  keyOf: (entry: DocCommitEntry) => string,
): Group[] {
  const map = new Map<string, DocCommitEntry[]>();

  for (const entry of entries) {
    const key = keyOf(entry);
    const current = map.get(key) ?? [];
    current.push(entry);
    map.set(key, current);
  }

  return [...map.values()]
    .map((chunk) => {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];

      if (first === undefined || last === undefined) {
        return null;
      }

      return {
        tier,
        entries: chunk,
        periodStart: Math.min(...chunk.map((entry) => entry.committedAt)),
        periodEnd: Math.max(...chunk.map((entry) => entry.committedAt)),
      } satisfies Group;
    })
    .filter((group): group is Group => group !== null)
    .sort((left, right) => right.periodEnd - left.periodEnd);
}

function monthKey(entry: DocCommitEntry): string {
  const date = new Date(entry.committedAt);

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function yearKey(entry: DocCommitEntry): string {
  return String(new Date(entry.committedAt).getUTCFullYear());
}

function renderGroup(group: Group): string {
  const first = group.entries[group.entries.length - 1];
  const last = group.entries[0];

  if (first === undefined || last === undefined) {
    return '';
  }

  const maxTokens =
    group.tier === 'T1'
      ? DOC_COMPRESSION.T1_MAX_TOKENS
      : group.tier === 'T2'
        ? DOC_COMPRESSION.T2_MAX_TOKENS
        : DOC_COMPRESSION.T3_MAX_TOKENS;
  const lines = [
    `### ${group.tier} 摘要（${group.entries.length} 次提交）`,
    '',
    `- 范围：\`${first.commitSha.slice(0, 8)}\` → \`${last.commitSha.slice(0, 8)}\``,
    `- 时间：${new Date(group.periodStart).toISOString()} → ${new Date(group.periodEnd).toISOString()}`,
    '',
    ...group.entries.map(
      (entry) =>
        `- ${entry.title}（\`${entry.commitSha.slice(0, 8)}\`，${entry.modules.join(' / ') || '未映射'}）`,
    ),
    '',
  ];

  return truncateToTokens(lines.join('\n'), maxTokens);
}

/**
 * T0 最近 100 条完整保留；其余从原始 T0 条目生成 T1/T2/T3。
 * 不读取任何已有 rollup，避免「摘要的摘要」造成信息持续损失。
 */
export function compressDocEntries(entries: readonly DocCommitEntry[]): DocRollup[] {
  const sorted = newestFirst(entries);
  const old = sorted.slice(DOC_COMPRESSION.T0_WINDOW);
  const t1Entries = old.slice(0, DOC_COMPRESSION.T1_END - DOC_COMPRESSION.T0_WINDOW);
  const t2Entries = old.slice(
    DOC_COMPRESSION.T1_END - DOC_COMPRESSION.T0_WINDOW,
    DOC_COMPRESSION.T2_END - DOC_COMPRESSION.T0_WINDOW,
  );
  const t3Entries = old.slice(DOC_COMPRESSION.T2_END - DOC_COMPRESSION.T0_WINDOW);
  const groups = [
    ...groupSequential(t1Entries, DOC_COMPRESSION.T1_GROUP_SIZE),
    ...groupByPeriod(t2Entries, 'T2', monthKey),
    ...groupByPeriod(t3Entries, 'T3', yearKey),
  ];

  return groups
    .map((group) => {
      const contentMd = renderGroup(group);
      const chronological = [...group.entries].sort(
        (left, right) => left.committedAt - right.committedAt,
      );
      const from = chronological[0]?.commitSha ?? '';
      const to = chronological[chronological.length - 1]?.commitSha ?? '';

      return {
        tier: group.tier,
        periodStart: group.periodStart,
        periodEnd: group.periodEnd,
        commitCount: group.entries.length,
        contentMd,
        sourceShaRange: { from, to },
        sourceEntryIds: group.entries.map((entry) => entry.commitSha),
        tokenCount: estimateTokens(contentMd),
      } satisfies DocRollup;
    })
    .sort((left, right) => right.periodEnd - left.periodEnd);
}
