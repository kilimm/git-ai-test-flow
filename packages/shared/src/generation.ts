// 本文件所有改动要求遵循 agent-rules 规范

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

export const JOB_TYPE_GENERATION = 'generation.run';

export const GENERATION_LIMITS = {
  /** 单文件超过 200 KB 时截断，只保留前 N 字节。 */
  MAX_FILE_BYTES: 200 * 1024,
  /** 总 diff 超过 1.5 MB 时按优先级截断。 */
  MAX_TOTAL_BYTES: 1_536 * 1024,
  /** 场景步骤数超过 15 时给出警告。 */
  MAX_STEPS_PER_SCENARIO: 15,
  /** 生成重写最多 2 次。 */
  MAX_RETRIES: 2,
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
  mode: 'current' | 'range';
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
  affectedModules: string[];
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
  commits: number;
  filesChanged: number;
  filesIncluded: number;
  filesSkipped: number;
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
