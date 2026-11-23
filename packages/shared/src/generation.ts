// 本文件所有改动要求遵循 agent-rules 规范

import type { ModuleTreeNode } from './module-tree.js';

/** 生成任务状态机：queued → running → awaiting_approval → committed / rejected / failed。 */
export const GENERATION_STATUSES = [
  'queued',
  'running',
  'validating',
  'awaiting_approval',
  'committed',
  'rejected',
  'failed',
  'no_op',
] as const;

export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const GENERATION_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  VALIDATING: 'validating',
  AWAITING_APPROVAL: 'awaiting_approval',
  COMMITTED: 'committed',
  REJECTED: 'rejected',
  FAILED: 'failed',
  NO_OP: 'no_op',
} as const satisfies Record<string, GenerationStatus>;

/**
 * 生成模式：
 * - current：分析产品仓库工作区未提交变更；
 * - range：分析两个提交之间的差异；
 * - baseline：忽略 diff，以空树为 base 对整个代码库快照做全量分析，生成初始用例集。
 */
export const GENERATION_MODES = ['current', 'range', 'baseline'] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];

/**
 * 用例生成颗粒度：
 * - high：覆盖所有可能出现报错的分支（含边界、异常、错误路径）；
 * - medium：只针对核心功能，但穷尽这些核心功能的所有可能报错分支；
 * - low：只针对核心功能的功能实现主流程分支。
 */
export const GENERATION_GRANULARITIES = ['high', 'medium', 'low'] as const;
export type GenerationGranularity = (typeof GENERATION_GRANULARITIES)[number];

export const DEFAULT_GENERATION_GRANULARITY: GenerationGranularity = 'medium';

/** 空树对象 ID；以它为 base 的 range diff 等价于「整个仓库快照」。 */
export const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 把未知字符串收敛为合法颗粒度，默认 medium。 */
export function parseGranularity(value: unknown): GenerationGranularity {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : DEFAULT_GENERATION_GRANULARITY;
}

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'edited'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EDITED: 'edited',
} as const satisfies Record<string, ApprovalStatus>;

export const DIFF_FILE_CATEGORIES = [
  'api',
  'frontend',
  'database',
  'config',
  'docs',
  'test',
  'infrastructure',
  'other',
] as const;

export type DiffFileCategory = (typeof DIFF_FILE_CATEGORIES)[number];

export const DIFF_FILE_CATEGORY = {
  API: 'api',
  FRONTEND: 'frontend',
  DATABASE: 'database',
  CONFIG: 'config',
  DOCS: 'docs',
  TEST: 'test',
  INFRASTRUCTURE: 'infrastructure',
  OTHER: 'other',
} as const satisfies Record<string, DiffFileCategory>;

export const RISK_LEVELS = ['high', 'medium', 'low'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LEVEL = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const satisfies Record<string, RiskLevel>;

export const TEST_LAYERS = ['ui', 'api', 'db', 'e2e'] as const;
export type TestLayer = (typeof TEST_LAYERS)[number];

export const FEATURE_DRAFT_ACTIONS = ['create', 'update', 'obsolete'] as const;
export type FeatureDraftAction = (typeof FEATURE_DRAFT_ACTIONS)[number];

export const COVERAGE_RELATIONS = ['covered', 'needs_update', 'new', 'obsolete'] as const;
export type CoverageRelation = (typeof COVERAGE_RELATIONS)[number];

export const GENERATION_LIMITS = {
  /** 单文件超过 200 KB 时截断，只保留前 N 字节。 */
  MAX_FILE_BYTES: 200 * 1024,
  /** 总 diff 超过 1.5 MB 时按优先级截断。 */
  MAX_TOTAL_BYTES: 1_536 * 1024,
  /** 场景步骤数超过 15 时给出警告。 */
  MAX_STEPS_PER_SCENARIO: 15,
  /** 生成重写最多 3 次（含首次共 4 轮），给评审反馈留出收敛空间。 */
  MAX_RETRIES: 3,
  /** 单次生成最多处理文件数，避免上下文失控。 */
  MAX_FILES_PER_GENERATION: 200,
} as const;

export const APPROVAL_DECISIONS = ['approve', 'edit', 'reject'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  committedAt: number;
  title: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export type DiffChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffChangeStatus;
  category: DiffFileCategory;
  binary: boolean;
  isDoc: boolean;
  isTest: boolean;
  isOpenApi: boolean;
  isSensitive: boolean;
  skipped: boolean;
  skipReason: string | null;
  truncated: boolean;
  sizeBytes: number;
  additions: number;
  deletions: number;
  patch: string;
  hunks: DiffHunk[];
}

export interface FilterStats {
  totalFiles: number;
  includedFiles: number;
  skippedFiles: number;
  truncatedFiles: number;
  sensitiveFiles: number;
  totalBytes: number;
  includedBytes: number;
  skippedByReason: Record<string, number>;
}

export interface DiffCollection {
  mode: GenerationMode;
  baseSha: string | null;
  headSha: string;
  branch: string | null;
  commits: CommitInfo[];
  files: DiffFile[];
  stats: FilterStats;
  truncated: boolean;
}

export interface FeaturePointSource {
  path: string;
  hunk: string;
  reason: string;
}

export interface FeaturePoint {
  id: string;
  title: string;
  description: string;
  kind: string;
  risk: RiskLevel;
  /** 功能点所属模块的层级 key（可多个），例如 ['posts.comments']。 */
  affectedModules: string[];
  /** affectedModules 的完整祖先链（含自身），例如 ['posts','posts.comments']；用于模块树与前缀过滤。 */
  modulePath?: string[];
  sources: FeaturePointSource[];
  docRefs: string[];
  existingCoverage: string[];
  suggestedLayer: TestLayer[];
}

export interface ExistingCase {
  id: string;
  caseKey: string;
  name: string;
  featurePath: string;
  moduleKey: string;
  tags: string[];
  fingerprint: string;
  status: 'active' | 'obsolete';
  coverage: CoverageRelation;
}

export interface FeatureDraft {
  generationFileId?: string;
  path: string;
  content: string;
  action: FeatureDraftAction;
}

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
  scenario?: string;
  step?: string;
}

export interface StepProposal {
  keyword: string;
  text: string;
  path: string;
  line: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  stepProposals: StepProposal[];
  scenarioCount: number;
}

export interface CritiqueIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface CritiqueResult {
  acceptable: boolean;
  summary: string;
  issues: CritiqueIssue[];
}

export interface GenerationTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface GenerationStats {
  /** 本次生成使用的模式与颗粒度（便于前端展示与事后统计）。 */
  mode: GenerationMode;
  granularity: GenerationGranularity;
  commits: number;
  filesChanged: number;
  filesIncluded: number;
  filesSkipped: number;
  /** 因总预算（1.5MB）或单文件上限被截断的文件数；>0 时前端应提示用户分批生成。 */
  filesTruncated: number;
  /** baseline 模式下特别提示：是否可能因预算/文件上限导致未覆盖全部文件。 */
  incomplete: boolean;
  /** 本次识别到的模块树（层级 key、直接/累计功能点数）；前端用于模块选择。 */
  modules?: ModuleTreeNode[];
  featurePoints: number;
  scenarios: number;
  existingCases: number;
  covered: number;
  needsUpdate: number;
  newCases: number;
  obsolete: number;
  retries: number;
  tokenUsage: GenerationTokenUsage;
  durationMs: number;
}
