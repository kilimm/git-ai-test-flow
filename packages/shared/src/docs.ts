// 本文件所有改动要求遵循 agent-rules 规范

export const DOC_TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type DocTier = (typeof DOC_TIERS)[number];

export const DOC_STATUSES = ['draft', 'committed', 'superseded'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_MODULE_STATUSES = ['active', 'stale', 'archived'] as const;
export type DocModuleStatus = (typeof DOC_MODULE_STATUSES)[number];

/** 最近 100 次提交保留 T0；第 101 起按规范滚动压缩。 */
export const DOC_COMPRESSION = Object.freeze({
  T0_WINDOW: 100,
  T1_END: 500,
  T2_END: 2_000,
  T1_GROUP_SIZE: 10,
  T1_MAX_TOKENS: 500,
  T2_MAX_TOKENS: 800,
  T3_MAX_TOKENS: 1_200,
  MODULE_TOKEN_BUDGET: 6_000,
});

export interface DocModuleDefinition {
  key: string;
  name: string;
  description: string;
  pathPatterns: string[];
  owner: string;
  dependsOn: string[];
}

export interface DocModuleManifest {
  modules: DocModuleDefinition[];
}

export interface DocCommitEntry {
  commitSha: string;
  committedAt: number;
  author: string;
  title: string;
  summaryMd: string;
  detailMd: string;
  files: string[];
  modules: string[];
  tokenCount: number;
}

export interface DocRollup {
  tier: Exclude<DocTier, 'T0'>;
  periodStart: number;
  periodEnd: number;
  commitCount: number;
  contentMd: string;
  sourceShaRange: { from: string; to: string };
  sourceEntryIds: string[];
  tokenCount: number;
}

export interface DocReferenceIssue {
  reference: string;
  kind: 'path' | 'api' | 'table';
  stale: boolean;
  message: string;
}

export interface DocModuleView {
  id: string;
  key: string;
  name: string;
  description: string;
  owner: string;
  pathPatterns: string[];
  dependsOn: string[];
  status: DocModuleStatus;
  updatedAt: string;
}

export interface DocVersionView {
  id: string;
  commitSha: string;
  contentMd: string;
  contentHash: string;
  summary: string | null;
  status: DocStatus;
  generated: boolean;
  humanEdited: boolean;
  tokenCount: number;
  createdAt: string;
}

export interface DocCommitEntryView {
  id: string;
  commitSha: string;
  committedAt: string;
  author: string;
  title: string;
  summaryMd: string;
  modules: string[];
  tokenCount: number;
}

/** 简化 token 估算：英文单词/数字与 CJK 字符分别计数，压缩预算用。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const words = text
    .replace(/[㐀-鿿]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  return cjk + Math.ceil(words * 1.3);
}
