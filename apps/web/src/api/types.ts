// 本文件所有改动要求遵循 agent-rules 规范
import type {
  ApprovalStatus,
  Classification,
  DatabaseType,
  DatabaseWriteMode,
  FeaturePoint,
  GenerationGranularity,
  GenerationStatus,
  HealthStatus,
  DocCommitEntryView,
  DocModuleView,
  DocVersionView,
  LlmProvider,
  LlmPurpose,
  ProjectAccessMode,
  ProjectRole,
  RunReport,
  RunSelection,
  RunStatus,
  SuiteMode,
  TenantRole,
  VersionSource,
} from '@gait/shared';

/** 创建运行页里 Commit 下拉选项（来自 GET /projects/:id/commits）。 */
export interface ProjectCommitOption {
  sha: string;
  shortSha: string;
  title: string;
  author: string;
  committedAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  productRepoUrl: string;
  defaultBranch: string;
  gitCredentialId: string | null;
  suiteMode: SuiteMode;
  suiteRepoUrl: string | null;
  suitePath: string | null;
  featureRoot: string;
  docsRoot: string;
  accessMode: ProjectAccessMode;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  durationMs?: number;
  testedAt?: string;
  checkedAt?: string;
}

export interface Credential {
  id: string;
  name: string;
  type: string;
  username: string | null;
  maskedSecret: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProfile {
  id: string;
  projectId: string;
  name: string;
  purpose: LlmPurpose;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  credentialId: string | null;
  credentialName: string | null;
  params: Record<string, unknown>;
  enabled: boolean;
  healthStatus: HealthStatus;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentProfile {
  id: string;
  projectId: string;
  name: string;
  apiBaseUrl: string;
  webBaseUrl: string | null;
  healthcheck: { url: string; expectedStatus: number; timeoutMs: number } | null;
  version: {
    source: VersionSource;
    endpoint: string | null;
    jsonPath: string | null;
    header: string | null;
    deployedSha: string | null;
    strictVersionMatch: boolean;
  };
  testAccountCredentialId: string | null;
  resetEndpoint: string | null;
  setupScript: string | null;
  teardownScript: string | null;
  envVars: Record<string, string>;
  db: {
    type: DatabaseType;
    host: string | null;
    port: number | null;
    name: string;
    schema: string | null;
    user: string | null;
    credentialId: string | null;
    ssl: boolean;
    isTest: boolean;
    writeMode: DatabaseWriteMode;
  } | null;
  browser: Record<string, unknown>;
  caseTimeoutMs: number;
  apiConcurrency: number;
  uiConcurrency: number;
  healthStatus: HealthStatus;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannel {
  id: string;
  projectId: string;
  name: string;
  maskedWebhook: string;
  events: string[];
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  detailJson: string;
  createdAt: string;
}

export interface GenerationFile {
  id: string;
  path: string;
  action: string;
  content: string;
  contentHash: string;
  scenarioCount: number;
  validationStatus: string;
  validationErrors: { code?: string; severity?: string; message?: string; path?: string }[];
  committedSha: string | null;
}

export interface Generation {
  id: string;
  projectId: string;
  mode: string;
  granularity: GenerationGranularity;
  baseSha: string | null;
  headSha: string;
  branch: string | null;
  trigger: string;
  status: GenerationStatus;
  approvalStatus: ApprovalStatus;
  model: string | null;
  promptVersion: string | null;
  featurePoints: FeaturePoint[];
  stats: Record<string, unknown>;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  files?: GenerationFile[];
}

export interface GenerationDetail extends Generation {
  files: GenerationFile[];
}

export interface Artifact {
  id: string;
  type: string;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  redacted: boolean;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
}

export interface StepResult {
  id: string;
  index: number;
  keyword: string;
  text: string;
  type: string;
  status: string;
  durationMs: number | null;
  output: Record<string, unknown>;
  error: Record<string, unknown> | null;
  artifacts: {
    id?: string;
    type?: string;
    path?: string;
    dataRelativePath?: string;
  }[];
}

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

export interface RunCase {
  id: string;
  featurePath: string;
  scenarioName: string;
  line: number;
  caseKey: string | null;
  tags: string[];
  layer: string | null;
  status: string;
  attempt: number;
  classification: Classification | null;
  confidence: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  repairStatus: string | null;
  repairs: RepairAttempt[];
  evidence: {
    errorCode?: string | null;
    rerun?: {
      attempted: boolean;
      passed: boolean;
      previousStatus: string;
      previousErrorCode: string | null;
      durationMs: number;
    };
    attribution?: {
      verdict: Classification;
      confidence: number;
      rootCause: string;
      evidenceRefs: string[];
      suggestedFix: string | null;
      testRepairAllowed: boolean;
      source: string;
      conflict: { otherVerdict: Classification; otherConfidence: number } | null;
    };
    evidence?: {
      version: number;
      collectedAt: number;
      failedStepIndex: number | null;
      steps: EvidenceStep[];
      logs: { source: string; artifactId: string; tail: string }[];
      history: {
        runId: string;
        headSha: string;
        caseStatus: string;
        classification: string | null;
      }[];
      diff: {
        available: boolean;
        files: {
          path: string;
          status: string;
          category: string;
          hunks: { header: string; content: string }[];
        }[];
        testFilesChanged: boolean;
      };
      codeLocations: { path: string; line: number | null; reason: string; confidence: number }[];
      signals: {
        endpoints: string[];
        selectors: string[];
        selectorChanged: boolean;
        testFilesChanged: boolean;
        productFilesChanged: boolean;
        codeTouchConfidence: number;
      };
    };
  };
  startedAt: string | null;
  finishedAt: string | null;
  steps: StepResult[];
  artifacts: Artifact[];
}

export interface RepairAttempt {
  id: string;
  attemptNo: number;
  repairClass: string;
  rationale: string;
  patchDiff: string | null;
  guardStatus: string;
  reviewStatus: string;
  featurePath: string | null;
  appliedCommit: string | null;
  createdAt: string;
}

export interface ProjectMemberAccess {
  userId: string;
  username: string;
  displayName: string;
  role: ProjectRole;
  createdAt: string;
}

export interface ProjectAccess {
  projectId: string;
  accessMode: ProjectAccessMode;
  effectiveRole: ProjectRole | null;
  canManage: boolean;
  members: ProjectMemberAccess[];
}

export interface RunSummary {
  id: string;
  projectId: string;
  environmentId: string | null;
  baselineEnvironmentId: string | null;
  generationId: string | null;
  trigger: string;
  baseSha: string | null;
  headSha: string;
  deployedSha: string | null;
  versionMatch: boolean | null;
  branch: string | null;
  namespace: string;
  status: RunStatus;
  selection: RunSelection;
  stats: {
    total?: number;
    passed?: number;
    failed?: number;
    error?: number;
    skipped?: number;
    flaky?: number;
    quarantined?: number;
    classifications?: Partial<Record<Classification, number>>;
    durationMs?: number;
    analysis?: {
      rule?: number;
      llm?: number;
      fallback?: number;
      llmInputTokens?: number;
      llmOutputTokens?: number;
    };
  };
  error: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  cases: RunCase[];
}

export interface CaseFile {
  id: string;
  path: string;
  moduleKey: string | null;
  tags: string[];
  scenarioCount: number;
  parseStatus: string;
  parseError: string | null;
  indexedAt: string;
}

export interface CaseItem {
  id: string;
  caseKey: string;
  name: string;
  featurePath: string;
  moduleKey: string;
  tags: string[];
  fingerprint: string;
  status: 'active' | 'obsolete';
  line: number;
}

export interface SsoProvider {
  id: string;
  name: string;
}

export interface TriggerConfig {
  id: string;
  projectId: string;
  name: string;
  type: 'schedule' | 'git_webhook' | 'deployment';
  action: 'generate' | 'run';
  enabled: boolean;
  cron: string | null;
  branch: string | null;
  environmentId: string | null;
  selection: RunSelection;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocModuleRecord = DocModuleView;
export type DocVersionRecord = DocVersionView;
export type DocCommitEntryRecord = DocCommitEntryView;

export type { ProjectAccessMode, ProjectRole, RunReport };
