// 本文件所有改动要求遵循 agent-rules 规范
import type { Classification } from './run.js';

/** 证据包版本：LLM 上下文与报告模板共享同一结构。 */
export const EVIDENCE_PACK_VERSION = 1;

export const ANALYSIS_LIMITS = Object.freeze({
  /** 失败用例最多重跑 1 次。 */
  MAX_RERUNS: 1,
  /** 单个用例最多保留的步骤证据数。 */
  MAX_EVIDENCE_STEPS: 50,
  /** 最多引用的相关变更文件数。 */
  MAX_DIFF_FILES: 20,
  /** 每个 diff hunk 进入证据包的最大字符数。 */
  MAX_HUNK_CHARS: 2_000,
  /** 历史基线最多查询条数。 */
  MAX_HISTORY_RUNS: 10,
  /** LLM 归因最低可采信置信度。 */
  LLM_MIN_CONFIDENCE: 0.6,
  /** 规则结论低于该阈值时允许 LLM 覆盖。 */
  RULE_OVERRIDE_THRESHOLD: 0.6,
  /** 单次 Run 最多调用 LLM 的失败用例数。 */
  MAX_LLM_CASES: 20,
  /** 单条通知最多尝试次数。 */
  MAX_NOTIFICATION_ATTEMPTS: 3,
  /** 通知响应体最多保留字符数。 */
  MAX_NOTIFICATION_RESPONSE_CHARS: 500,
  /** 修复建议单次最多修改场景数。 */
  MAX_REPAIR_SCENARIOS: 1,
  /** 修复建议单次最多修改步骤数。 */
  MAX_REPAIR_STEPS: 5,
  /** 修复后允许的最大内容变化比例。 */
  MAX_REPAIR_CONTENT_RATIO: 0.2,
  /** 超时放宽上限（20%）。 */
  MAX_TIMEOUT_INCREASE_RATIO: 0.2,
});

export interface EvidenceStep {
  index: number;
  keyword: string;
  text: string;
  type: string;
  status: string;
  durationMs: number | null;
  error: { code: string; message: string } | null;
  output: unknown;
}

export interface EvidenceArtifact {
  id: string;
  type: string;
  path: string;
  mime: string;
  size: number;
  redacted: boolean;
}

/** 日志尾部（console/脚本输出），已脱敏并截断。 */
export interface EvidenceLog {
  source: string;
  artifactId: string;
  tail: string;
}

export interface EvidenceHistoryEntry {
  runId: string;
  headSha: string;
  status: string;
  caseStatus: string;
  classification: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EvidenceDiffFile {
  path: string;
  status: string;
  category: string;
  hunks: { header: string; content: string }[];
}

export interface EvidenceCodeLocation {
  path: string;
  line: number | null;
  reason: string;
  confidence: number;
}

export interface EvidenceRerun {
  attempted: boolean;
  previousStatus: string;
  previousErrorCode: string | null;
  passed: boolean;
  durationMs: number;
}

/** 从失败步骤与 diff 中提取的规则信号。 */
export interface EvidenceSignals {
  failedStepType: string | null;
  failedStepKeyword: string | null;
  failedStepText: string | null;
  endpoints: string[];
  selectors: string[];
  /** UI 选择器出现在被删除的产品代码行中，疑似改名。 */
  selectorChanged: boolean;
  testFilesChanged: boolean;
  productFilesChanged: boolean;
  codeTouchConfidence: number;
}

export interface EvidenceEnvironment {
  id: string | null;
  name: string | null;
  apiBaseUrl: string | null;
  versionMatch: boolean | null;
  deployedSha: string | null;
  healthy: boolean | null;
}

export interface EvidenceRun {
  id: string;
  projectId: string;
  branch: string | null;
  baseSha: string | null;
  headSha: string;
  deployedSha: string | null;
  versionMatch: boolean | null;
  status: string;
  trigger: string;
}

export interface EvidenceCase {
  id: string;
  featurePath: string;
  scenarioName: string;
  line: number;
  caseKey: string | null;
  tags: string[];
  layer: string | null;
  status: string;
  attempt: number;
  errorMessage: string | null;
  /** 所属 feature 源码（截断并脱敏），用于修复建议与 LLM 上下文。 */
  featureSource: string | null;
}

/**
 * 失败用例证据包：所有字符串字段在进入 LLM 前已脱敏，
 * 敏感字段统一替换为 `<redacted>` / `****`。
 */
export interface EvidencePack {
  version: typeof EVIDENCE_PACK_VERSION;
  collectedAt: number;
  run: EvidenceRun;
  environment: EvidenceEnvironment;
  case: EvidenceCase;
  failedStepIndex: number | null;
  steps: EvidenceStep[];
  artifacts: EvidenceArtifact[];
  logs: EvidenceLog[];
  history: EvidenceHistoryEntry[];
  signals: EvidenceSignals;
  diff: {
    available: boolean;
    files: EvidenceDiffFile[];
    testFilesChanged: boolean;
    truncated: boolean;
  };
  codeLocations: EvidenceCodeLocation[];
  rerun: EvidenceRerun | null;
  redacted: boolean;
}

/** 归因来源：规则、LLM、重跑或证据不足兜底。 */
export const ATTRIBUTION_SOURCES = ['rule', 'llm', 'rerun', 'fallback'] as const;
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

export interface AttributionResult {
  verdict: Classification;
  confidence: number;
  rootCause: string;
  evidenceRefs: string[];
  suggestedFix: string | null;
  testRepairAllowed: boolean;
  source: AttributionSource;
  /** 与另一来源结论冲突时记录，报告显式标注。 */
  conflict: { otherVerdict: Classification; otherConfidence: number } | null;
}

export interface LlmAttribution {
  verdict: Classification;
  confidence: number;
  rootCause: string;
  evidenceRefs: string[];
  suggestedFix: string | null;
  testRepairAllowed: boolean;
}

export const REPAIR_GUARD_STATUSES = ['allowed', 'blocked', 'human_required'] as const;
export type RepairGuardStatus = (typeof REPAIR_GUARD_STATUSES)[number];

export const REPAIR_GUARD_STATUS = {
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
  HUMAN_REQUIRED: 'human_required',
} as const satisfies Record<string, RepairGuardStatus>;

export interface RepairGuardFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface RepairGuardResult {
  status: RepairGuardStatus;
  findings: RepairGuardFinding[];
}

/** 修复审批状态：安全修复可自动，其余等待具备 repair:approve 的用户。 */
export const REPAIR_REVIEW_STATUSES = ['not_required', 'pending', 'approved', 'rejected'] as const;
export type RepairReviewStatus = (typeof REPAIR_REVIEW_STATUSES)[number];

export interface RepairProposalResult {
  repairClass: string;
  rationale: string;
  patch: RepairFilePatch | null;
  guard: RepairGuardResult;
  evidenceRefs: string[];
  model: string | null;
}

export interface RepairFilePatch {
  path: string;
  originalContent: string;
  patchedContent: string;
}

export interface RepairGuardInput {
  patches: RepairFilePatch[];
  /** 产品代码变更证据（代码 Bug 定位），用于校验预期值变化。 */
  codeEvidenceAvailable: boolean;
  /** 修复是否来自高置信 test_bug 归因。 */
  highConfidenceTestBug: boolean;
  /** 之前已执行的修复次数。 */
  priorAttempts: number;
}

export interface RepairProposal {
  repairClass: string;
  rationale: string;
  patches: RepairFilePatch[];
  guard: RepairGuardResult;
}

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export const NOTIFICATION_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const satisfies Record<string, NotificationStatus>;

export interface NotificationErrorInfo {
  code: string;
  message: string;
}

export interface ReportDistribution {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  quarantined: number;
  flaky: number;
  byClassification: Record<Classification, number>;
}

export interface ReportCodeLocation {
  path: string;
  line: number | null;
  reason: string;
  confidence: number;
}

export interface ReportFailure {
  runCaseId: string;
  caseKey: string | null;
  scenarioName: string;
  featurePath: string;
  layer: string | null;
  status: string;
  classification: Classification | null;
  confidence: number | null;
  rootCause: string | null;
  suggestedFix: string | null;
  testRepairAllowed: boolean;
  evidenceRefs: string[];
  codeLocations: ReportCodeLocation[];
  rerunPassed: boolean;
  repairStatus: string | null;
  errorMessage: string | null;
  repro: {
    environmentId: string | null;
    caseKey: string | null;
    runUrl: string;
  };
}

export interface ReportRepair {
  runCaseId: string;
  attemptNo: number;
  repairClass: string;
  rationale: string;
  guardStatus: string;
  appliedCommit: string | null;
  createdAt: string;
}

export interface ReportNotification {
  channelId: string | null;
  eventType: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  sentAt: string | null;
}

export interface ReportTrend {
  window: number;
  passRate: number;
  flakyRate: number;
  averageDurationMs: number;
  llmInputTokens: number;
  llmOutputTokens: number;
}

/** P1 历史基线/多环境对比摘要；未配置基线环境时为 null。 */
export interface ReportBaseline {
  environmentId: string;
  environmentName: string | null;
  historyRuns: number;
  passed: number;
  failed: number;
  flaky: number;
  summary: string;
}

export interface RunReport {
  version: 1;
  generatedAt: string;
  overview: {
    runId: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    tenantSlug: string;
    branch: string | null;
    baseSha: string | null;
    headSha: string;
    deployedSha: string | null;
    versionMatch: boolean | null;
    environmentId: string | null;
    environmentName: string | null;
    baselineEnvironmentId: string | null;
    trigger: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number;
    passRate: number;
    runUrl: string;
  };
  distribution: ReportDistribution;
  failures: ReportFailure[];
  repairs: ReportRepair[];
  trend: ReportTrend | null;
  baseline: ReportBaseline | null;
  notifications: ReportNotification[];
  attachments: { type: string; path: string; mime: string }[];
}

export type ReportFormat = 'json' | 'markdown' | 'html' | 'junit';

export const REPORT_FORMATS: readonly ReportFormat[] = ['json', 'markdown', 'html', 'junit'];
