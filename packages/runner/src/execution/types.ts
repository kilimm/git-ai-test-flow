// 本文件所有改动要求遵循 agent-rules 规范
import type { DbAdapter } from '../db/types.js';
import type { HttpExecutor, HttpExecutionResult } from '../http/executor.js';
import type { ArtifactStore, StoredArtifact } from '../artifacts/artifact-store.js';
import type { UiDriver } from '../ui/driver.js';
import type { StepExecutionType, StepStatus } from '@gait/shared';

export interface TestAccount {
  username: string;
  password: string;
}

export interface ExecutionEnvironment {
  apiBaseUrl: string;
  webBaseUrl: string | null;
  testAccount: TestAccount | null;
  caseTimeoutMs: number;
}

export interface ScenarioIdentity {
  runId: string;
  runCaseId: string;
  featurePath: string;
  scenarioName: string;
  caseKey: string | null;
  tags: string[];
  layer: string | null;
  namespace: string;
}

/** 单个场景运行期的可变上下文。 */
export interface StepRuntime {
  variables: {
    env: Record<string, unknown>;
    fixture: Record<string, unknown>;
    secret: Record<string, unknown>;
    var: Record<string, unknown>;
    steps: Record<string, unknown>;
    run: Record<string, unknown>;
  };
  environment: ExecutionEnvironment;
  http: HttpExecutor;
  db: DbAdapter | null;
  suiteRoot: string;
  artifacts: ArtifactStore;
  uiFactory: (() => Promise<UiDriver>) | null;
  ui: UiDriver | null;
  /** API-agent：把 [agent] 语言指令转为 HTTP 请求执行；null 时回退到视觉/UI。 */
  apiAgent: {
    llm: {
      generate(request: {
        system: string;
        user: string;
        temperature?: number;
        maxTokens?: number;
        timeoutMs?: number;
      }): Promise<{ text: string }>;
    };
    scenarioHint: string;
  } | null;
  signal: AbortSignal | undefined;
  /**
   * 是否允许测试数据重置（`the test database is prepared` 会 DELETE 全表）。
   * 只有串行执行（并发度=1）时才能置 true；并发执行时置 false，
   * 否则一条用例的清库会摧毁其他用例刚写入的数据。
   */
  allowDatabaseReset?: boolean;
  headers: Record<string, string>;
  lastResponse: HttpExecutionResult | null;
  identity: ScenarioIdentity;
}

export interface StepOutcome {
  status: Extract<StepStatus, 'passed' | 'failed' | 'skipped' | 'error'>;
  type: StepExecutionType;
  durationMs: number;
  output: Record<string, unknown>;
  error: { code: string; message: string } | null;
  artifacts: StoredArtifact[];
}

export class StepExecutionError extends Error {
  readonly code: string;
  readonly outcome: 'failed' | 'error' | 'skipped';

  constructor(
    code: string,
    message: string,
    outcome: 'failed' | 'error' | 'skipped' = 'error',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StepExecutionError';
    this.code = code;
    this.outcome = outcome;
  }
}

export interface ScenarioStepRecord {
  index: number;
  keyword: string;
  text: string;
  type: StepExecutionType;
  status: StepOutcome['status'];
  durationMs: number;
  error: { code: string; message: string } | null;
  artifacts: StoredArtifact[];
  output: Record<string, unknown>;
}

export type ScenarioRunStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'canceled';

export interface ScenarioRunResult {
  status: ScenarioRunStatus;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  steps: ScenarioStepRecord[];
  trace: Buffer | null;
  consoleMessages: string[];
  failureScreenshot: Buffer | null;
}

export interface StepResultSink {
  /** 在执行前创建 step_result 行并返回 ID，供产物关联。 */
  start(record: {
    index: number;
    keyword: string;
    text: string;
    type: StepExecutionType;
  }): Promise<string>;
  finish(stepResultId: string, record: ScenarioStepRecord): Promise<void>;
}
