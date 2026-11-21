// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs } from '@gait/config';
import { UrlSafetyChecker } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  ArtifactRepository,
  EnvironmentRepository,
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunEventRepository,
  RunRepository,
  StepResultRepository,
} from '@gait/db';
import type { AppDatabase, Environment, Project, RepairAttempt, Run, RunCase } from '@gait/db';
import { collectRangeDiff } from '@gait/git';
import type { GitAuth } from '@gait/git';
import {
  RUN_ERROR_CODE,
  RUN_LIMITS,
  emptyRunStats,
  normalizeRunSelection,
  runNamespace,
  selectionMatches,
} from '@gait/shared';
import type {
  Classification,
  DatabaseWriteMode,
  RunCaseStatus,
  RunSelection,
  RunStats,
  RunStatus,
} from '@gait/shared';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { createDbAdapter } from '../db/adapters.js';
import {
  createFixtureContext,
  parseFixtureDocument,
  resolveFixtureVariables,
  runFixtureSetup,
} from '../db/fixtures.js';
import type { DbAdapter, DbAdapterConfig, DbAdapterDeps } from '../db/types.js';
import { verifyEnvironment } from '../environment/verify-environment.js';
import type { EnvironmentVerificationResult } from '../environment/verify-environment.js';
import { parseFeatureSource } from '../gherkin/parse.js';
import type { ParsedFeature, ParsedScenario } from '../gherkin/parse.js';
import { HttpExecutor } from '../http/executor.js';
import type { HttpExecutorOptions } from '../http/executor.js';
import { StepRegistry, parseSuiteStepCatalog } from '../steps/registry.js';
import type { UiDriver } from '../ui/driver.js';
import { PlaywrightUiDriver } from '../ui/playwright-driver.js';
import type { PlaywrightUiOptions } from '../ui/playwright-driver.js';
import { RunWorkspace } from '../workspace/run-workspace.js';
import { environmentMutex, mirrorMutex } from './keyed-mutex.js';
import { mapWithConcurrency } from './concurrency.js';
import { runScenario } from '../execution/scenario-runner.js';
import type {
  ExecutionEnvironment,
  ScenarioIdentity,
  StepResultSink,
  TestAccount,
} from '../execution/types.js';
import { StepExecutionError } from '../execution/types.js';

export interface RunLogger {
  info?(details: Record<string, unknown>, message?: string): void;
  warn?(details: Record<string, unknown>, message?: string): void;
  error?(details: Record<string, unknown>, message?: string): void;
}

export interface RunExecutorOptions {
  db: AppDatabase;
  env: AppEnv;
  tenantId: string;
  runId: string;
  gitAuth?: GitAuth | null;
  testAccount?: TestAccount | null;
  dbPassword?: string | null;
  signal?: AbortSignal;
  logger?: RunLogger;
  now?: () => number;
  urlSafety?: UrlSafetyChecker;
  fetchImpl?: typeof fetch;
  uiDriverFactory?: (options: PlaywrightUiOptions) => Promise<UiDriver>;
  dbAdapterFactory?: (config: DbAdapterConfig, deps?: DbAdapterDeps) => DbAdapter;
  httpExecutorFactory?: (options: HttpExecutorOptions) => HttpExecutor;
  maxWorkspaceBytes?: number;
  cancelPollIntervalMs?: number;
  runTimeoutMs?: number;
}

export interface RunStageResult {
  ok: boolean;
  code: string | null;
  message: string | null;
  canceled?: boolean;
}

export class RunExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunExecutorError';
    this.code = code;
  }
}

interface CaseRuntimeContext {
  feature: ParsedFeature;
  scenario: ParsedScenario;
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (json === null || json === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function mergedTags(featureTags: readonly string[], scenarioTags: readonly string[]): string[] {
  return [...new Set([...featureTags, ...scenarioTags])];
}

function layerOf(tags: readonly string[]): string | null {
  const layer = tags.find((tag) => tag.startsWith('layer:'));

  return layer === undefined ? null : layer.slice('layer:'.length);
}

function caseKeyOf(tags: readonly string[]): string | null {
  const key = tags.find((tag) => tag.startsWith('case:'));

  return key === undefined ? null : key.slice('case:'.length);
}

function browserOptions(environment: Environment | undefined): PlaywrightUiOptions {
  const browser = parseObject(environment?.browserJson);
  const viewport = parseObject(
    typeof browser.viewport === 'object' && browser.viewport !== null
      ? JSON.stringify(browser.viewport)
      : '{}',
  );
  const width = Number(viewport.width);
  const height = Number(viewport.height);

  return {
    headless: browser.headless === undefined ? true : browser.headless !== false,
    ...(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { viewport: { width, height } }
      : {}),
    ...(typeof browser.locale === 'string' ? { locale: browser.locale } : {}),
    ...(typeof browser.timezone === 'string' ? { timezone: browser.timezone } : {}),
    ...(Number.isFinite(Number(browser.timeoutMs)) && Number(browser.timeoutMs) > 0
      ? { timeoutMs: Number(browser.timeoutMs) }
      : {}),
    trace: true,
  };
}

/**
 * 单次 Run 的执行器：由 Graph B 节点依次调用 prepare/verify/prepareData/discover/run/aggregate。
 * 所有状态写入数据库，进程重启后可重新发现用例并继续执行。
 */
export class RunExecutor {
  private readonly options: RunExecutorOptions;
  private readonly clock: () => number;
  private readonly runRepository: RunRepository;
  private readonly caseRepository: RunCaseRepository;
  private readonly stepRepository: StepResultRepository;
  private readonly artifactRepository: ArtifactRepository;
  private readonly eventRepository: RunEventRepository;
  private readonly environmentRepository: EnvironmentRepository;
  private readonly urlSafety: UrlSafetyChecker;
  private run: Run;
  private project: Project;
  private environment: Environment | undefined;
  private workspace: RunWorkspace | null = null;
  private adapter: DbAdapter | null = null;
  private adapterMessage: string | null = null;
  private teardownFixtures: (() => Promise<number>) | null = null;
  private fixtureVariables: Record<string, unknown> = {};
  private envVariables: Record<string, unknown> = {};
  private secretVariables: Record<string, unknown> = {};
  private selection: RunSelection;
  private impactModules: string[] = [];
  private envLockRelease: (() => void) | null = null;
  private canceled = false;
  private runTimedOut = false;
  private closed = false;

  private constructor(
    options: RunExecutorOptions,
    run: Run,
    project: Project,
    environment: Environment | undefined,
    selection: RunSelection,
  ) {
    this.options = options;
    this.clock = options.now ?? (() => nowMs());
    this.run = run;
    this.project = project;
    this.environment = environment;
    this.selection = selection;
    this.runRepository = new RunRepository(options.db, options.tenantId);
    this.caseRepository = new RunCaseRepository(options.db, options.tenantId);
    this.stepRepository = new StepResultRepository(options.db, options.tenantId);
    this.artifactRepository = new ArtifactRepository(options.db, options.tenantId);
    this.eventRepository = new RunEventRepository(options.db, options.tenantId);
    this.environmentRepository = new EnvironmentRepository(options.db, options.tenantId);
    this.urlSafety =
      options.urlSafety ?? new UrlSafetyChecker({ allowlist: options.env.SSRF_ALLOWLIST });
  }

  static create(options: RunExecutorOptions): RunExecutor {
    const run = new RunRepository(options.db, options.tenantId).findById(options.runId);

    if (run === undefined) {
      throw new RunExecutorError('RUN_NOT_FOUND', `Run not found: ${options.runId}`);
    }

    const project = new ProjectRepository(options.db, options.tenantId).findById(run.projectId);

    if (project === undefined) {
      throw new RunExecutorError('PROJECT_NOT_FOUND', 'Run project not found');
    }

    const environment =
      run.environmentId === null
        ? undefined
        : new EnvironmentRepository(options.db, options.tenantId).findById(run.environmentId);
    const selection = normalizeRunSelection(
      parseObject(run.selectionJson) as {
        type?: string;
        modules?: string[];
        caseKeys?: string[];
      },
    );

    return new RunExecutor(options, run, project, environment, selection);
  }

  get runId(): string {
    return this.run.id;
  }

  get namespace(): string {
    return runNamespace(this.run.id);
  }

  /** 归因阶段读取 Suite 中的场景源码；工作区未就绪时返回 null。 */
  readSuiteFile(relativePath: string): string | null {
    if (this.workspace === null) {
      return null;
    }

    try {
      return this.workspace.suite.readFile(relativePath);
    } catch {
      return null;
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    details: Record<string, unknown>,
    message: string,
  ): void {
    this.options.logger?.[level]?.({ runId: this.run.id, ...details }, message);
  }

  private event(type: string, payload: unknown): void {
    try {
      this.eventRepository.append({
        runId: this.run.id,
        type,
        payload,
        now: this.clock(),
      });
    } catch (error) {
      this.log(
        'warn',
        { error: error instanceof Error ? error.message : String(error) },
        'run event write failed',
      );
    }
  }

  private updateRun(
    values: Parameters<RunRepository['update']>[1],
    now: number = this.clock(),
  ): Run {
    const updated = this.runRepository.update(this.run.id, values, now);

    if (updated === undefined) {
      throw new RunExecutorError('RUN_NOT_FOUND', 'Run disappeared during execution');
    }

    this.run = updated;

    return updated;
  }

  private updateActiveRun(
    values: Parameters<RunRepository['update']>[1],
    now: number = this.clock(),
  ): Run | undefined {
    const updated = this.runRepository.updateActive(this.run.id, values, now);

    if (updated !== undefined) {
      this.run = updated;
    }

    return updated;
  }

  /** 状态机第一步：获取环境/镜像锁并准备隔离工作区。 */
  private async openWorkspace(): Promise<RunWorkspace> {
    const current = this.runRepository.findById(this.run.id);

    if (current?.status === 'canceled') {
      this.canceled = true;
      throw new RunExecutorError(RUN_ERROR_CODE.RUN_CANCELED, 'Run canceled');
    }

    if (this.envLockRelease === null) {
      this.envLockRelease = await environmentMutex.acquire(
        `environment:${this.run.environmentId ?? this.project.id}`,
      );
    }

    const now = this.clock();

    const prepared = this.updateActiveRun(
      {
        status: 'preparing',
        startedAt: this.run.startedAt ?? now,
        workflowThreadId: `run:${this.run.id}`,
      },
      now,
    );

    if (prepared === undefined) {
      const latest = this.runRepository.findById(this.run.id);

      if (latest?.status === 'canceled') {
        this.canceled = true;
        throw new RunExecutorError(RUN_ERROR_CODE.RUN_CANCELED, 'Run canceled');
      }

      throw new RunExecutorError('RUN_NOT_RUNNABLE', 'Run is already finished');
    }

    let workspace: RunWorkspace;

    try {
      workspace = await mirrorMutex.run(`mirror:${this.project.id}`, () =>
        RunWorkspace.open({
          dataDir: this.options.env.DATA_DIR,
          tenantId: this.options.tenantId,
          projectId: this.project.id,
          projectSlug: this.project.slug,
          runId: this.run.id,
          productRepoUrl: this.project.productRepoUrl,
          suiteMode: this.project.suiteMode,
          suiteRepoUrl: this.project.suiteRepoUrl,
          suitePath: this.project.suitePath,
          featureRoot: this.project.featureRoot,
          docsRoot: this.project.docsRoot,
          headSha: this.run.headSha,
          gitAuth: this.options.gitAuth ?? null,
          ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
          ...(this.options.maxWorkspaceBytes === undefined
            ? {}
            : { maxBytes: this.options.maxWorkspaceBytes }),
        }),
      );
    } catch (error) {
      this.envLockRelease?.();
      this.envLockRelease = null;
      throw error;
    }

    this.workspace = workspace;

    // 环境变量只在内存中使用；敏感值由凭据单独注入。
    this.envVariables = {
      ...parseObject(this.environment?.envVarsJson),
      apiBaseUrl: this.environment?.apiBaseUrl ?? '',
      webBaseUrl: this.environment?.webBaseUrl ?? null,
    };

    return workspace;
  }

  /** checkpoint 恢复时 prepare 节点可能被跳过，后续阶段可幂等重建工作区。 */
  private async ensureWorkspace(): Promise<RunWorkspace> {
    return this.workspace ?? this.openWorkspace();
  }

  async prepareWorkspace(): Promise<RunStageResult> {
    try {
      await this.openWorkspace();

      return { ok: true, code: null, message: null };
    } catch (error) {
      const code =
        error instanceof RunExecutorError
          ? error.code
          : typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : RUN_ERROR_CODE.WORKSPACE_FAILED;
      const message = error instanceof Error ? error.message : String(error);
      const canceled = code === RUN_ERROR_CODE.RUN_CANCELED;

      return { ok: false, code, message, ...(canceled ? { canceled: true } : {}) };
    }
  }

  /** 环境健康与版本校验；失败即终止，不进入用例执行。 */
  async verifyEnvironment(): Promise<RunStageResult> {
    if (this.environment === undefined) {
      return {
        ok: false,
        code: RUN_ERROR_CODE.ENV_UNHEALTHY,
        message: 'Run environment is not configured',
      };
    }

    let result: EnvironmentVerificationResult;

    try {
      result = await verifyEnvironment({
        profile: {
          apiBaseUrl: this.environment.apiBaseUrl,
          healthcheckUrl: this.environment.healthcheckUrl,
          healthcheckExpectedStatus: this.environment.healthcheckExpectedStatus,
          healthcheckTimeoutMs: this.environment.healthcheckTimeoutMs,
          versionSource: this.environment.versionSource,
          versionEndpoint: this.environment.versionEndpoint,
          versionJsonPath: this.environment.versionJsonPath,
          versionHeader: this.environment.versionHeader,
          deployedSha: this.environment.deployedSha,
          strictVersionMatch: this.environment.strictVersionMatch,
        },
        targetHeadSha: this.run.headSha,
        urlSafety: this.urlSafety,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
        now: this.clock,
      });
    } catch (error) {
      result = {
        ok: false,
        healthy: false,
        code: RUN_ERROR_CODE.ENV_UNHEALTHY,
        message: error instanceof Error ? error.message : String(error),
        status: null,
        durationMs: 0,
        deployedSha: null,
        versionMatch: null,
        healthcheckUrl: this.environment.healthcheckUrl,
      };
    }

    const now = this.clock();

    this.environmentRepository.update(
      this.environment.id,
      {
        healthStatus: result.healthy ? 'healthy' : 'unhealthy',
        healthCheckedAt: now,
        healthMessage: result.message.slice(0, 500),
        deployedSha: result.deployedSha,
      },
      now,
    );
    this.environment = this.environmentRepository.findById(this.environment.id);
    this.updateRun(
      {
        deployedSha: result.deployedSha,
        versionMatch: result.versionMatch,
      },
      now,
    );

    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message };
    }

    return {
      ok: true,
      code: result.code,
      message: result.message,
    };
  }

  /** 准备数据库连接与 fixtures；数据库不可用不阻断纯 API/UI 用例。 */
  async prepareTestData(): Promise<RunStageResult> {
    try {
      await this.ensureWorkspace();
    } catch (error) {
      const code = error instanceof RunExecutorError ? error.code : RUN_ERROR_CODE.WORKSPACE_FAILED;

      return {
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    this.secretVariables =
      this.options.testAccount === null || this.options.testAccount === undefined
        ? {}
        : { testAccount: this.options.testAccount };

    if (this.environment?.dbType !== null && this.environment?.dbType !== undefined) {
      try {
        const adapterConfig: DbAdapterConfig = {
          type: this.environment.dbType,
          host: this.environment.dbHost,
          port: this.environment.dbPort,
          name: this.environment.dbName ?? '',
          schema: this.environment.dbSchema,
          user: this.environment.dbUser,
          password: this.options.dbPassword ?? null,
          ssl: this.environment.dbSsl,
          isTest: this.environment.dbIsTest,
          writeMode: this.environment.dbWriteMode as DatabaseWriteMode,
        };
        const adapter = (this.options.dbAdapterFactory ?? createDbAdapter)(adapterConfig);
        const ping = await adapter.ping();

        if (ping.ok) {
          this.adapter = adapter;
        } else {
          this.adapterMessage = ping.message ?? 'Database is unavailable';
          await adapter.close();
          this.log(
            'warn',
            { message: this.adapterMessage },
            'database unavailable; db steps will fail',
          );
        }
      } catch (error) {
        this.adapterMessage = error instanceof Error ? error.message : String(error);
        this.log(
          'warn',
          { message: this.adapterMessage },
          'database connection rejected; db steps will fail',
        );
      }
    }

    const setupScript = this.environment?.setupScript ?? null;

    if (setupScript !== null && setupScript.trim().length > 0) {
      if (this.adapter === null) {
        return {
          ok: false,
          code: RUN_ERROR_CODE.DB_CONNECTION_FAILED,
          message: this.adapterMessage ?? 'Database is required by setupScript',
        };
      }

      try {
        const source = this.workspace?.suite.readFile(setupScript);

        if (source === null || source === undefined) {
          return {
            ok: false,
            code: RUN_ERROR_CODE.FIXTURE_FAILED,
            message: `Fixture file not found: ${setupScript}`,
          };
        }

        const document = parseFixtureDocument(source, setupScript);
        const context = createFixtureContext(
          { env: this.envVariables, run: this.runVariables() },
          this.namespace,
        );
        const setup = await runFixtureSetup(this.adapter, document, context);

        this.teardownFixtures = setup.teardown;
        this.fixtureVariables = resolveFixtureVariables(document.variables, context);
        this.event('fixture.prepared', { statements: setup.statements, file: setupScript });
      } catch (error) {
        return {
          ok: false,
          code: RUN_ERROR_CODE.FIXTURE_FAILED,
          message: error instanceof Error ? error.message.slice(0, 500) : String(error),
        };
      }
    }

    return { ok: true, code: null, message: null };
  }

  private runVariables(): Record<string, unknown> {
    return {
      id: this.run.id,
      namespace: this.namespace,
      shortId: this.namespace.replace(/^run_/, '').replace(/_$/, ''),
      projectId: this.project.id,
      headSha: this.run.headSha,
      deployedSha: this.run.deployedSha,
      environmentId: this.run.environmentId,
    };
  }

  private stepRegistry(): StepRegistry {
    if (this.workspace === null) {
      throw new RunExecutorError('WORKSPACE_MISSING', 'Workspace is not prepared');
    }

    return StepRegistry.createDefault(
      parseSuiteStepCatalog(this.workspace.suite.readFile('steps/registry.json')),
    );
  }

  private async discoverFromSuite(): Promise<{
    entries: {
      featurePath: string;
      feature: ParsedFeature;
      scenario: ParsedScenario;
      tags: string[];
    }[];
  }> {
    if (this.workspace === null) {
      throw new RunExecutorError('WORKSPACE_MISSING', 'Workspace is not prepared');
    }

    // SuiteRepository 的同步文件 API 在本阶段前已由 workspace 初始化。
    const files = await this.workspace.suite.listFeatureFiles();
    const entries: {
      featurePath: string;
      feature: ParsedFeature;
      scenario: ParsedScenario;
      tags: string[];
    }[] = [];

    for (const file of files) {
      const parsed = parseFeatureSource(file.content);

      if (parsed.feature === null) {
        this.log('warn', { path: file.path }, 'skip unparsable feature');
        continue;
      }

      for (const scenario of parsed.feature.scenarios) {
        const tags = mergedTags(parsed.feature.tags, scenario.tags);

        if (selectionMatches(this.selection, tags, caseKeyOf(tags), this.impactModules)) {
          entries.push({
            featurePath: file.path,
            feature: parsed.feature,
            scenario,
            tags,
          });
        }
      }
    }

    return { entries };
  }

  private static readonly IMPACT_IGNORED_SEGMENTS = new Set([
    'src',
    'app',
    'apps',
    'packages',
    'lib',
    'libs',
    'server',
    'client',
    'api',
    'db',
    'database',
    'features',
    'test',
    'tests',
    '__tests__',
    'spec',
    'docs',
    'public',
    'assets',
  ]);

  private modulesFromPaths(paths: readonly string[]): string[] {
    const modules = new Set<string>();

    for (const path of paths) {
      const segments = path.replace(/\\/g, '/').split('/');

      for (const segment of segments) {
        const normalized = segment
          .replace(/\.[A-Za-z0-9]+$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, '-');

        if (
          normalized.length >= 2 &&
          !RunExecutor.IMPACT_IGNORED_SEGMENTS.has(normalized) &&
          !normalized.startsWith('.')
        ) {
          modules.add(normalized);
        }
      }
    }

    return [...modules].slice(0, 100);
  }

  /** 影响面选测：从 base..head 变更路径推断模块名，与 @module: tag 匹配。 */
  private async resolveImpactModules(): Promise<string[]> {
    if (this.selection.type !== 'impact') {
      return [];
    }

    if (this.workspace === null || this.run.baseSha === null) {
      return [];
    }

    const diff = await collectRangeDiff({
      repoPath: this.workspace.mirror,
      baseSha: this.run.baseSha,
      headSha: this.run.headSha,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    });
    const modules = this.modulesFromPaths(diff.files.map((file) => file.path));

    this.event('run.impact', { baseSha: this.run.baseSha, headSha: this.run.headSha, modules });

    return modules;
  }

  /** 发现 Suite 中符合条件的场景并写入 run_cases。 */
  async discoverCases(): Promise<RunStageResult> {
    try {
      if (this.caseRepository.listByRun(this.run.id).length > 0) {
        return { ok: true, code: null, message: null };
      }

      await this.ensureWorkspace();
      this.impactModules = await this.resolveImpactModules();
      const { entries } = await this.discoverFromSuite();

      if (entries.length === 0) {
        return {
          ok: false,
          code: RUN_ERROR_CODE.NO_CASES_FOUND,
          message: 'No scenarios matched the run selection',
        };
      }

      const limited = entries.slice(0, RUN_LIMITS.MAX_CASES_PER_RUN);

      this.caseRepository.createMany(
        limited.map((entry) => ({
          runId: this.run.id,
          featurePath: entry.featurePath,
          scenarioName: entry.scenario.name,
          line: entry.scenario.line,
          caseKey: caseKeyOf(entry.tags),
          tags: entry.tags,
          layer: layerOf(entry.tags),
        })),
        this.clock(),
      );

      if (entries.length > limited.length) {
        this.log('warn', { dropped: entries.length - limited.length }, 'run case limit reached');
      }

      return { ok: true, code: null, message: null };
    } catch (error) {
      return {
        ok: false,
        code: RUN_ERROR_CODE.INTERNAL,
        message: error instanceof Error ? error.message.slice(0, 500) : String(error),
      };
    }
  }

  private async caseContextMap(): Promise<Map<string, CaseRuntimeContext>> {
    const map = new Map<string, CaseRuntimeContext>();

    if (this.workspace === null) {
      return map;
    }

    for (const file of await this.workspace.suite.listFeatureFiles()) {
      const parsed = parseFeatureSource(file.content);

      if (parsed.feature === null) {
        continue;
      }

      for (const scenario of parsed.feature.scenarios) {
        map.set(`${file.path}#${scenario.line}`, { feature: parsed.feature, scenario });
      }
    }

    return map;
  }

  private makeSink(runCase: RunCase): StepResultSink {
    return {
      start: async (record) => {
        const row = this.stepRepository.create(
          {
            runCaseId: runCase.id,
            stepIndex: record.index,
            keyword: record.keyword,
            text: record.text,
            type: record.type,
            status: 'running',
          },
          this.clock(),
        );

        this.event('step.started', {
          runCaseId: runCase.id,
          stepIndex: record.index,
          type: record.type,
        });

        return row.id;
      },
      finish: async (stepResultId, record) => {
        this.stepRepository.update(
          stepResultId,
          {
            status: record.status,
            durationMs: record.durationMs,
            outputJson: JSON.stringify(record.output),
            errorJson: record.error === null ? null : JSON.stringify(record.error),
            artifactsJson: JSON.stringify(
              record.artifacts.map((artifact) => ({
                id: artifact.id,
                type: artifact.type,
                path: artifact.path,
                dataRelativePath: artifact.dataRelativePath,
              })),
            ),
          },
          this.clock(),
        );
        this.event('step.finished', {
          runCaseId: runCase.id,
          stepIndex: record.index,
          status: record.status,
          durationMs: record.durationMs,
        });
      },
    };
  }

  private async executeCase(
    runCase: RunCase,
    contexts: Map<string, CaseRuntimeContext>,
    http: HttpExecutor,
    caseSignal: AbortSignal,
    options: {
      attempt?: number;
      rerun?: { previousStatus: string; previousErrorCode: string | null };
    } = {},
  ): Promise<void> {
    const startedAt = this.clock();
    const attempt = options.attempt ?? runCase.attempt;

    this.caseRepository.update(runCase.id, { status: 'running', attempt, startedAt });
    this.event('case.started', {
      runCaseId: runCase.id,
      caseKey: runCase.caseKey,
      attempt,
    });

    const context = contexts.get(`${runCase.featurePath}#${runCase.line}`);

    if (context === undefined) {
      this.caseRepository.update(runCase.id, {
        status: 'error',
        attempt,
        durationMs: 0,
        errorMessage: 'Scenario is no longer present in the Suite',
        finishedAt: this.clock(),
      });
      this.event('case.finished', { runCaseId: runCase.id, status: 'error', attempt });

      return;
    }

    const layer = runCase.layer;
    const tags = parseArray(runCase.tagsJson);
    const identity: ScenarioIdentity = {
      runId: this.run.id,
      runCaseId: runCase.id,
      featurePath: runCase.featurePath,
      scenarioName: runCase.scenarioName,
      caseKey: runCase.caseKey,
      tags,
      layer,
      namespace: this.namespace,
    };
    const caseArtifactStore = new ArtifactStore(
      {
        dataDir: this.options.env.DATA_DIR,
        tenantId: this.options.tenantId,
        runId: this.run.id,
        repository: this.artifactRepository,
        now: this.clock,
      },
      { runCaseId: runCase.id, stepResultId: null },
    );
    const environment: ExecutionEnvironment = {
      apiBaseUrl: this.environment?.apiBaseUrl ?? '',
      webBaseUrl: this.environment?.webBaseUrl ?? null,
      testAccount: this.options.testAccount ?? null,
      caseTimeoutMs: this.environment?.caseTimeoutMs ?? RUN_LIMITS.DEFAULT_CASE_TIMEOUT_MS,
    };
    const variableRoots = {
      env: { ...this.envVariables },
      fixture: { ...this.fixtureVariables },
      secret: { ...this.secretVariables },
      var: {} as Record<string, unknown>,
      steps: {} as Record<string, unknown>,
      run: this.runVariables(),
    };
    const uiOptions = browserOptions(this.environment);
    const createUi =
      layer === 'ui' || layer === 'e2e'
        ? () =>
            (
              this.options.uiDriverFactory ??
              ((options: PlaywrightUiOptions) => PlaywrightUiDriver.launch(options))
            )(uiOptions)
        : null;
    let result;

    try {
      result = await runScenario({
        featurePath: runCase.featurePath,
        feature: context.feature,
        scenario: context.scenario,
        stepRegistry: this.stepRegistry(),
        environment,
        http,
        db: this.adapter,
        suiteRoot: this.workspace?.suite.root ?? '',
        artifacts: caseArtifactStore,
        uiFactory: createUi,
        identity,
        variableRoots,
        sink: this.makeSink(runCase),
        signal: caseSignal,
        caseTimeoutMs:
          layer === 'ui' || layer === 'e2e'
            ? Math.max(environment.caseTimeoutMs, RUN_LIMITS.UI_CASE_TIMEOUT_MS)
            : environment.caseTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
      const status: RunCaseStatus = this.canceled ? 'skipped' : 'error';

      this.caseRepository.update(runCase.id, {
        status,
        attempt,
        durationMs: this.clock() - startedAt,
        errorMessage: message,
        finishedAt: this.clock(),
      });
      this.event('case.finished', { runCaseId: runCase.id, status, error: message, attempt });

      return;
    }

    let tracePath: string | null = null;
    let consolePath: string | null = null;

    if (result.trace !== null) {
      tracePath = caseArtifactStore.writeBuffer(
        'trace',
        'trace',
        result.trace,
        'application/zip',
      ).dataRelativePath;
    }

    if (result.consoleMessages.length > 0) {
      consolePath = caseArtifactStore.writeText(
        'console',
        'console',
        result.consoleMessages.join('\n'),
      ).dataRelativePath;
    }

    if (result.failureScreenshot !== null) {
      caseArtifactStore.writeBuffer(
        'screenshot',
        'failure-screenshot',
        result.failureScreenshot,
        'image/png',
      );
    }

    const caseStatus: RunCaseStatus =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'failed'
          ? 'failed'
          : result.status === 'skipped'
            ? 'skipped'
            : result.status === 'canceled'
              ? this.canceled
                ? 'skipped'
                : this.runTimedOut
                  ? 'error'
                  : 'skipped'
              : 'error';
    const rerunPassed = options.rerun !== undefined && result.status === 'passed';
    const classification: Classification | null =
      result.errorCode === RUN_ERROR_CODE.DB_CONNECTION_FAILED ||
      result.errorCode === RUN_ERROR_CODE.DB_NOT_CONFIGURED ||
      result.errorCode === 'UI_NOT_CONFIGURED' ||
      result.errorCode === RUN_ERROR_CODE.ENV_UNHEALTHY
        ? 'env_issue'
        : rerunPassed
          ? 'flaky'
          : result.status === 'passed'
            ? null
            : 'unknown';
    const previousEvidence = parseObject(runCase.evidenceJson);
    const evidence = {
      ...previousEvidence,
      errorCode: result.errorCode,
      tracePath,
      consolePath,
      stepCount: result.steps.length,
      ...(options.rerun === undefined
        ? {}
        : {
            rerun: {
              attempted: true,
              previousStatus: options.rerun.previousStatus,
              previousErrorCode: options.rerun.previousErrorCode,
              passed: rerunPassed,
              durationMs: result.durationMs,
            },
          }),
    };

    this.caseRepository.update(runCase.id, {
      status: caseStatus,
      attempt,
      durationMs: result.durationMs,
      errorMessage:
        this.runTimedOut && result.status === 'canceled' ? 'Run timed out' : result.errorMessage,
      evidenceJson: JSON.stringify(evidence),
      classification,
      finishedAt: this.clock(),
    });
    this.event('case.finished', {
      runCaseId: runCase.id,
      status: caseStatus,
      durationMs: result.durationMs,
      errorCode: result.errorCode,
      attempt,
    });
  }

  /** 同环境并发配置下重跑失败用例；每个用例最多 1 次，结果写入 evidence.rerun。 */
  async rerunFailedCases(): Promise<RunStageResult> {
    const latest = this.runRepository.findById(this.run.id);

    if (latest?.status === 'canceled') {
      this.canceled = true;

      return {
        ok: true,
        code: RUN_ERROR_CODE.RUN_CANCELED,
        message: 'Run canceled',
        canceled: true,
      };
    }

    try {
      await this.ensureWorkspace();
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RunExecutorError ? error.code : RUN_ERROR_CODE.WORKSPACE_FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const failed = this.caseRepository
      .listByRun(this.run.id)
      .filter(
        (runCase) =>
          (runCase.status === 'failed' || runCase.status === 'error') &&
          runCase.classification !== 'env_issue' &&
          runCase.attempt < 1 + RUN_LIMITS.RERUN_MAX_ATTEMPTS,
      );

    if (failed.length === 0) {
      return { ok: true, code: null, message: null };
    }

    const now = this.clock();
    const analyzing = this.updateActiveRun({ status: 'analyzing' }, now);

    if (analyzing === undefined) {
      const current = this.runRepository.findById(this.run.id);

      if (current?.status === 'canceled') {
        this.canceled = true;

        return {
          ok: true,
          code: RUN_ERROR_CODE.RUN_CANCELED,
          message: 'Run canceled',
          canceled: true,
        };
      }

      return { ok: true, code: null, message: null };
    }

    const apiConcurrency = Math.max(
      1,
      Math.min(
        this.environment?.apiConcurrency ?? RUN_LIMITS.API_CONCURRENCY,
        RUN_LIMITS.MAX_API_CONCURRENCY,
      ),
    );
    const uiConcurrency = Math.max(
      1,
      Math.min(
        this.environment?.uiConcurrency ?? RUN_LIMITS.UI_CONCURRENCY,
        RUN_LIMITS.MAX_UI_CONCURRENCY,
      ),
    );
    const contexts = await this.caseContextMap();
    const http = (
      this.options.httpExecutorFactory ??
      ((options: HttpExecutorOptions) => new HttpExecutor(options))
    )({
      baseUrl: this.environment?.apiBaseUrl ?? 'http://127.0.0.1',
      urlSafety: this.urlSafety,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    const controller = new AbortController();
    const workerSignal = this.options.signal;
    const combinedSignal =
      workerSignal === undefined
        ? controller.signal
        : AbortSignal.any([workerSignal, controller.signal]);
    const cancelPoll = setInterval(() => {
      const current = this.runRepository.findById(this.run.id);

      if (current?.status === 'canceled') {
        this.canceled = true;
        controller.abort();
      }
    }, this.options.cancelPollIntervalMs ?? RUN_LIMITS.CANCEL_POLL_INTERVAL_MS);
    const rerun = async (runCase: RunCase): Promise<void> => {
      if (combinedSignal.aborted) {
        return;
      }

      const evidence = parseObject(runCase.evidenceJson);
      const previousErrorCode = typeof evidence.errorCode === 'string' ? evidence.errorCode : null;

      this.stepRepository.deleteByRunCase(runCase.id);
      this.caseRepository.update(runCase.id, {
        attempt: runCase.attempt + 1,
        classification: null,
        confidence: null,
        repairStatus: null,
        errorMessage: null,
      });
      this.event('case.rerun', {
        runCaseId: runCase.id,
        previousStatus: runCase.status,
        previousErrorCode,
      });
      await this.executeCase(runCase, contexts, http, combinedSignal, {
        attempt: runCase.attempt + 1,
        rerun: { previousStatus: runCase.status, previousErrorCode },
      });
    };

    this.event('run.rerun', { runId: this.run.id, total: failed.length });

    try {
      await Promise.all([
        mapWithConcurrency(
          failed.filter((item) => item.layer !== 'ui' && item.layer !== 'e2e'),
          apiConcurrency,
          rerun,
          combinedSignal,
        ),
        mapWithConcurrency(
          failed.filter((item) => item.layer === 'ui' || item.layer === 'e2e'),
          uiConcurrency,
          rerun,
          combinedSignal,
        ),
      ]);
    } catch (error) {
      if (workerSignal?.aborted === true) {
        throw error;
      }

      this.log(
        'error',
        { error: error instanceof Error ? error.message : String(error) },
        'case rerun failed',
      );
    } finally {
      clearInterval(cancelPoll);
    }

    if (this.canceled) {
      for (const runCase of this.caseRepository.listByRun(this.run.id)) {
        if (runCase.status === 'pending' || runCase.status === 'running') {
          this.caseRepository.update(runCase.id, {
            status: 'skipped',
            errorMessage: 'Run was canceled',
            finishedAt: this.clock(),
          });
        }
      }

      return {
        ok: true,
        code: RUN_ERROR_CODE.RUN_CANCELED,
        message: 'Run canceled',
        canceled: true,
      };
    }

    return { ok: true, code: null, message: null };
  }

  /**
   * M9 自修复：只应用 guard=allowed 且 reviewStatus=not_required 的补丁，
   * 重跑受影响场景；通过后把补丁提交到 Suite，失败则保留结果并标记 repairStatus=failed。
   * 高风险补丁不会走到这里，必须通过 repair:approve 审批和新的 Run 验证。
   */
  async repairFailedCases(): Promise<RunStageResult> {
    const latest = this.runRepository.findById(this.run.id);

    if (latest?.status === 'canceled') {
      return {
        ok: true,
        code: RUN_ERROR_CODE.RUN_CANCELED,
        message: 'Run canceled',
        canceled: true,
      };
    }

    try {
      await this.ensureWorkspace();
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RunExecutorError ? error.code : RUN_ERROR_CODE.WORKSPACE_FAILED,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (this.workspace === null) {
      return { ok: false, code: RUN_ERROR_CODE.WORKSPACE_FAILED, message: 'Workspace missing' };
    }

    const repairRepository = new RepairAttemptRepository(this.options.db, this.options.tenantId);
    const candidates: Array<{ runCase: RunCase; attempt: RepairAttempt }> = [];

    for (const runCase of this.caseRepository.listByRun(this.run.id)) {
      if (runCase.status !== 'failed' && runCase.status !== 'error') {
        continue;
      }

      const attempt = repairRepository
        .listByRunCase(runCase.id)
        .find(
          (item) =>
            item.guardStatus === 'allowed' &&
            item.reviewStatus === 'not_required' &&
            item.patchedContent !== null,
        );

      if (attempt !== undefined) {
        candidates.push({ runCase, attempt });
      }
    }

    if (candidates.length === 0) {
      return { ok: true, code: null, message: null };
    }

    const staged = new Map<string, string>();

    for (const { attempt } of candidates) {
      const path = attempt.featurePath;

      if (path === null || attempt.patchedContent === null) {
        continue;
      }

      try {
        if (this.workspace.suite.readFile(path) !== attempt.originalContent) {
          this.log('warn', { path }, 'repair skipped because suite content changed');
          continue;
        }

        this.workspace.suite.stageFeatureFile(path, attempt.patchedContent);
        staged.set(path, attempt.patchedContent);
      } catch (error) {
        this.log(
          'warn',
          { path, error: error instanceof Error ? error.message : String(error) },
          'repair patch could not be staged',
        );
      }
    }

    if (staged.size === 0) {
      return { ok: true, code: null, message: null };
    }

    const contexts = await this.caseContextMap();
    const http = (
      this.options.httpExecutorFactory ??
      ((options: HttpExecutorOptions) => new HttpExecutor(options))
    )({
      baseUrl: this.environment?.apiBaseUrl ?? 'http://127.0.0.1',
      urlSafety: this.urlSafety,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    const controller = new AbortController();
    const workerSignal = this.options.signal;
    const signal =
      workerSignal === undefined
        ? controller.signal
        : AbortSignal.any([workerSignal, controller.signal]);
    let applied = 0;

    for (const { runCase, attempt } of candidates) {
      const current = this.caseRepository.findById(runCase.id);

      if (
        current === undefined ||
        attempt.patchedContent === null ||
        attempt.featurePath === null ||
        !staged.has(attempt.featurePath)
      ) {
        continue;
      }

      this.stepRepository.deleteByRunCase(current.id);
      this.event('case.repair.started', {
        runCaseId: current.id,
        repairId: attempt.id,
        attemptNo: attempt.attemptNo,
      });
      await this.executeCase(current, contexts, http, signal, {
        attempt: current.attempt + 1,
        rerun: {
          previousStatus: current.status,
          previousErrorCode: null,
        },
      });
      const after = this.caseRepository.findById(current.id);

      if (after?.status === 'passed') {
        applied += 1;
        this.caseRepository.update(current.id, {
          repairStatus: 'verified',
          classification: 'test_bug',
        });
        repairRepository.update(attempt.id, {
          verifiedAt: this.clock(),
          reviewStatus: 'approved',
        });
      } else {
        this.caseRepository.update(current.id, { repairStatus: 'failed' });
      }

      this.event('case.repair.finished', {
        runCaseId: current.id,
        status: after?.status ?? 'unknown',
        repairId: attempt.id,
      });
    }

    if (applied === 0) {
      return { ok: true, code: null, message: null };
    }

    try {
      const commit = await this.workspace.suite.writeAndCommit(
        [...staged.entries()].map(([path, content]) => ({ path, content })),
        `test: apply verified repair ${this.run.id}`,
      );

      for (const { attempt } of candidates) {
        if (this.caseRepository.findById(attempt.runCaseId)?.repairStatus === 'verified') {
          repairRepository.update(attempt.id, { appliedCommit: commit.commitSha });
        }
      }

      this.event('run.repaired', {
        runId: this.run.id,
        applied,
        commitSha: commit.commitSha,
        changed: commit.changed,
      });

      return { ok: true, code: null, message: null };
    } catch (error) {
      return {
        ok: false,
        code: RUN_ERROR_CODE.REPAIR_FAILED,
        message: error instanceof Error ? error.message.slice(0, 500) : String(error),
      };
    }
  }

  /** 执行已发现的用例；API 与 UI 用例分别按环境并发配置执行。 */
  async runCases(): Promise<RunStageResult> {
    if (this.run.status === 'canceled') {
      this.canceled = true;

      return {
        ok: true,
        code: RUN_ERROR_CODE.RUN_CANCELED,
        message: 'Run canceled',
        canceled: true,
      };
    }

    try {
      await this.ensureWorkspace();
    } catch (error) {
      const code = error instanceof RunExecutorError ? error.code : RUN_ERROR_CODE.WORKSPACE_FAILED;

      return {
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const environments = this.environment;
    const apiConcurrency = Math.max(
      1,
      Math.min(
        environments?.apiConcurrency ?? RUN_LIMITS.API_CONCURRENCY,
        RUN_LIMITS.MAX_API_CONCURRENCY,
      ),
    );
    const uiConcurrency = Math.max(
      1,
      Math.min(
        environments?.uiConcurrency ?? RUN_LIMITS.UI_CONCURRENCY,
        RUN_LIMITS.MAX_UI_CONCURRENCY,
      ),
    );
    const now = this.clock();
    const running = this.updateActiveRun(
      { status: 'running', startedAt: this.run.startedAt ?? now },
      now,
    );

    if (running === undefined) {
      const latest = this.runRepository.findById(this.run.id);

      if (latest?.status === 'canceled') {
        this.canceled = true;

        return {
          ok: true,
          code: RUN_ERROR_CODE.RUN_CANCELED,
          message: 'Run canceled',
          canceled: true,
        };
      }

      return {
        ok: false,
        code: 'RUN_NOT_RUNNABLE',
        message: 'Run is already finished',
      };
    }

    const cases = this.caseRepository.listByRun(this.run.id);

    this.event('run.started', {
      runId: this.run.id,
      headSha: this.run.headSha,
      deployedSha: this.run.deployedSha,
      total: cases.length,
    });

    const contexts = await this.caseContextMap();
    const http = (
      this.options.httpExecutorFactory ??
      ((options: HttpExecutorOptions) => new HttpExecutor(options))
    )({
      baseUrl: this.environment?.apiBaseUrl ?? 'http://127.0.0.1',
      urlSafety: this.urlSafety,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    const controller = new AbortController();
    const workerSignal = this.options.signal;
    const combinedSignal =
      workerSignal === undefined
        ? controller.signal
        : AbortSignal.any([workerSignal, controller.signal]);
    const runTimeoutMs = this.options.runTimeoutMs ?? RUN_LIMITS.RUN_TIMEOUT_MS;
    const timeoutTimer = setTimeout(() => {
      this.runTimedOut = true;
      controller.abort();
    }, runTimeoutMs);
    const cancelPoll = setInterval(() => {
      const current = this.runRepository.findById(this.run.id);

      if (current?.status === 'canceled') {
        this.canceled = true;
        controller.abort();
      }
    }, this.options.cancelPollIntervalMs ?? RUN_LIMITS.CANCEL_POLL_INTERVAL_MS);
    const apiCases = cases.filter((item) => item.layer !== 'ui' && item.layer !== 'e2e');
    const uiCases = cases.filter((item) => item.layer === 'ui' || item.layer === 'e2e');

    try {
      await Promise.all([
        mapWithConcurrency(
          apiCases,
          apiConcurrency,
          (runCase) => this.executeCase(runCase, contexts, http, combinedSignal),
          combinedSignal,
        ),
        mapWithConcurrency(
          uiCases,
          uiConcurrency,
          (runCase) => this.executeCase(runCase, contexts, http, combinedSignal),
          combinedSignal,
        ),
      ]);
    } catch (error) {
      if (workerSignal?.aborted === true) {
        throw error;
      }

      this.log(
        'error',
        { error: error instanceof Error ? error.message : String(error) },
        'case execution failed',
      );
    } finally {
      clearTimeout(timeoutTimer);
      clearInterval(cancelPoll);
    }

    if (workerSignal?.aborted === true) {
      throw new StepExecutionError(
        'RUN_ABORTED',
        'Worker lease lost; run will be retried',
        'error',
      );
    }

    if (this.canceled) {
      for (const runCase of this.caseRepository.listByRun(this.run.id)) {
        if (runCase.status === 'pending' || runCase.status === 'running') {
          this.caseRepository.update(runCase.id, {
            status: 'skipped',
            errorMessage: 'Run was canceled',
            finishedAt: this.clock(),
          });
        }
      }

      return {
        ok: true,
        code: RUN_ERROR_CODE.RUN_CANCELED,
        message: 'Run canceled',
        canceled: true,
      };
    }

    if (this.runTimedOut) {
      return { ok: true, code: RUN_ERROR_CODE.RUN_TIMEOUT, message: 'Run timed out' };
    }

    return { ok: true, code: null, message: null };
  }

  private computeStats(): { stats: RunStats; status: RunStatus } {
    const cases = this.caseRepository.listByRun(this.run.id);
    const stats = emptyRunStats();
    const current = this.runRepository.findById(this.run.id);
    const analysis = parseObject(current?.statsJson).analysis;
    const startedAt = this.run.startedAt ?? this.clock();

    if (analysis !== null && typeof analysis === 'object' && !Array.isArray(analysis)) {
      const raw = analysis as Record<string, unknown>;

      stats.analysis = {
        analyzedAt: typeof raw.analyzedAt === 'number' ? raw.analyzedAt : 0,
        rule: typeof raw.rule === 'number' ? raw.rule : 0,
        llm: typeof raw.llm === 'number' ? raw.llm : 0,
        fallback: typeof raw.fallback === 'number' ? raw.fallback : 0,
        llmInputTokens: typeof raw.llmInputTokens === 'number' ? raw.llmInputTokens : 0,
        llmOutputTokens: typeof raw.llmOutputTokens === 'number' ? raw.llmOutputTokens : 0,
      };
    }

    stats.total = cases.length;

    for (const runCase of cases) {
      if (runCase.status === 'passed') {
        stats.passed += 1;
      } else if (runCase.status === 'failed') {
        stats.failed += 1;
      } else if (runCase.status === 'error') {
        stats.error += 1;
      } else if (runCase.status === 'skipped') {
        stats.skipped += 1;
      } else if (runCase.status === 'quarantined') {
        stats.quarantined += 1;
      }

      if (runCase.classification === 'flaky') {
        stats.flaky += 1;
      }

      if (runCase.classification !== null) {
        stats.classifications[runCase.classification] += 1;
      }
    }

    stats.canceled = this.canceled
      ? cases.filter((runCase) => runCase.status === 'skipped').length
      : 0;
    stats.durationMs = Math.max(0, this.clock() - startedAt);
    stats.concurrency = {
      api: Math.max(
        1,
        Math.min(
          this.environment?.apiConcurrency ?? RUN_LIMITS.API_CONCURRENCY,
          RUN_LIMITS.MAX_API_CONCURRENCY,
        ),
      ),
      ui: Math.max(
        1,
        Math.min(
          this.environment?.uiConcurrency ?? RUN_LIMITS.UI_CONCURRENCY,
          RUN_LIMITS.MAX_UI_CONCURRENCY,
        ),
      ),
    };
    const status: RunStatus = this.canceled
      ? 'canceled'
      : this.runTimedOut || stats.total === 0 || stats.failed > 0 || stats.error > 0
        ? 'failed'
        : 'succeeded';

    return { stats, status };
  }

  /** 汇总结果并写入终态；取消优先于失败。 */
  async aggregate(): Promise<RunStageResult> {
    const { stats, status } = this.computeStats();
    const error =
      status === 'canceled'
        ? { code: RUN_ERROR_CODE.RUN_CANCELED, message: 'Run canceled' }
        : this.runTimedOut
          ? { code: RUN_ERROR_CODE.RUN_TIMEOUT, message: 'Run timed out' }
          : null;

    this.updateRun({
      status,
      statsJson: JSON.stringify(stats),
      errorJson: error === null ? null : JSON.stringify(error),
      finishedAt: this.clock(),
    });
    this.event('run.finished', { runId: this.run.id, status, stats });

    return {
      ok: true,
      code: error?.code ?? null,
      message: error?.message ?? null,
    };
  }

  /** 失败终态：取消状态不被覆盖。 */
  async fail(code: string, message: string): Promise<void> {
    const current = this.runRepository.findById(this.run.id);

    if (current?.status === 'canceled') {
      return;
    }

    const classification =
      code === RUN_ERROR_CODE.ENV_UNHEALTHY ||
      code === RUN_ERROR_CODE.ENV_VERSION_MISMATCH ||
      code === RUN_ERROR_CODE.DB_CONNECTION_FAILED ||
      code === 'SSRF_BLOCKED'
        ? 'env_issue'
        : null;

    this.updateRun({
      status: 'failed',
      errorJson: JSON.stringify({
        code,
        message: message.slice(0, 500),
        ...(classification === null ? {} : { classification }),
      }),
      finishedAt: this.clock(),
    });
    this.event('run.finished', { runId: this.run.id, status: 'failed', error: code });
  }

  /** 释放 fixtures、数据库连接、工作区与环境锁；可重复调用。 */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.teardownFixtures !== null) {
      try {
        await this.teardownFixtures();
      } catch (error) {
        this.log(
          'warn',
          { error: error instanceof Error ? error.message : String(error) },
          'fixture teardown failed',
        );
      }

      this.teardownFixtures = null;
    }

    if (this.adapter !== null) {
      await this.adapter.close().catch(() => undefined);
      this.adapter = null;
    }

    if (this.workspace !== null) {
      const errors = await this.workspace.close();

      if (errors.length > 0) {
        this.log('warn', { errors }, 'workspace cleanup reported errors');
      }

      this.workspace = null;
    }

    this.envLockRelease?.();
    this.envLockRelease = null;
  }
}
