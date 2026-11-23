// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactRepository,
  EnvironmentRepository,
  RunCaseRepository,
  RunEventRepository,
  RunRepository,
} from '@gait/db';
import { runGit } from '@gait/git';
import { RunExecutor } from '../src/index.js';
import { PlaywrightUiDriver } from '../src/index.js';
import type { RunExecutor as RunExecutorType, RunExecutorOptions, UiDriver } from '../src/index.js';
import { setupRunFixture, write } from './run-fixtures.js';
import type { RunFixture } from './run-fixtures.js';

const fixtures: RunFixture[] = [];

async function fixture(options: Parameters<typeof setupRunFixture>[0] = {}): Promise<RunFixture> {
  const value = await setupRunFixture(options);

  fixtures.push(value);

  return value;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.close();
  }
});

interface StageOutcome {
  outcome: 'completed' | 'failed' | 'canceled';
  failureCode: string | null;
}

async function runStages(executor: RunExecutorType): Promise<StageOutcome> {
  const stages = [
    () => executor.prepareWorkspace(),
    () => executor.verifyEnvironment(),
    () => executor.prepareTestData(),
    () => executor.discoverCases(),
    () => executor.runCases(),
  ];

  for (const stage of stages) {
    const result = await stage();

    if (!result.ok) {
      if (result.canceled === true) {
        await executor.aggregate();

        return { outcome: 'canceled', failureCode: result.code };
      }

      await executor.fail(result.code ?? 'RUN_FAILED', result.message ?? 'Run stage failed');

      return { outcome: 'failed', failureCode: result.code };
    }

    if (result.canceled === true) {
      await executor.aggregate();

      return { outcome: 'canceled', failureCode: result.code };
    }
  }

  await executor.aggregate();

  return { outcome: 'completed', failureCode: null };
}

async function execute(
  fixtureValue: RunFixture,
  runId: string,
  overrides: Partial<RunExecutorOptions> = {},
): Promise<RunExecutorType> {
  return RunExecutor.create({
    db: fixtureValue.database.db,
    env: fixtureValue.env,
    tenantId: fixtureValue.tenant.id,
    runId,
    ...overrides,
  });
}

class StaticUiDriver implements UiDriver {
  private url = '';

  async goto(url: string): Promise<void> {
    this.url = url;
  }

  async fill(): Promise<void> {
    return;
  }

  async click(): Promise<void> {
    return;
  }

  async isVisible(): Promise<boolean> {
    return true;
  }

  async textContent(): Promise<string | null> {
    return 'Welcome';
  }

  async pageText(): Promise<string> {
    return 'Welcome to Demo';
  }

  async waitForLoad(): Promise<void> {
    return;
  }

  currentUrl(): string {
    return this.url;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('png');
  }

  async startTrace(): Promise<void> {
    return;
  }

  async stopTrace(): Promise<Buffer | null> {
    return Buffer.from('trace');
  }

  consoleMessages(): readonly string[] {
    return ['log: test'];
  }

  async close(): Promise<void> {
    return;
  }
}

describe('run executor', () => {
  it('executes API and DB scenarios end to end with artifacts', async () => {
    const value = await fixture();
    const run = await value.createRun({
      type: 'cases',
      modules: [],
      caseKeys: ['RUN-API-001', 'RUN-API-002', 'RUN-DB-001'],
    });
    const executor = await execute(value, run.id);

    const result = await runStages(executor);

    await executor.close();

    expect(result.outcome).toBe('completed');
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);

    expect(stored?.status).toBe('succeeded');
    expect(stored?.deployedSha).toBe(value.headSha);
    expect(stored?.versionMatch).toBe(true);
    const stats = JSON.parse(stored?.statsJson ?? '{}') as {
      total: number;
      passed: number;
      failed: number;
      error: number;
    };

    expect(stats).toMatchObject({ total: 3, passed: 3, failed: 0, error: 0 });

    const cases = await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(run.id);

    expect(cases.map((runCase) => runCase.status)).toEqual(['passed', 'passed', 'passed']);
    expect(cases.every((runCase) => (runCase.durationMs ?? 0) >= 0)).toBe(true);

    const sqlite = new Database(value.dbPath, { readonly: true });
    const rows = sqlite.prepare('SELECT title FROM posts').all() as { title: string }[];

    sqlite.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title.startsWith('run_')).toBe(true);

    const artifacts = await new ArtifactRepository(value.database.db, value.tenant.id).listByRun(
      run.id,
    );

    expect(artifacts.some((artifact) => artifact.type === 'api_request')).toBe(true);
    expect(artifacts.some((artifact) => artifact.type === 'api_response')).toBe(true);
    expect(artifacts.some((artifact) => artifact.type === 'db_snapshot')).toBe(true);
    expect(artifacts.every((artifact) => existsSync(join(value.dataDir, artifact.path)))).toBe(
      true,
    );
    expect(artifacts.every((artifact) => artifact.redacted)).toBe(true);

    const events = await new RunEventRepository(value.database.db, value.tenant.id).listByRun(
      run.id,
    );

    expect(events.map((event) => event.type)).toContain('run.started');
    expect(events.map((event) => event.type)).toContain('run.finished');

    const environment = await new EnvironmentRepository(
      value.database.db,
      value.tenant.id,
    ).findById(value.environment.id);

    expect(environment?.healthStatus).toBe('healthy');
    expect(environment?.deployedSha).toBe(value.headSha);
    expect(
      existsSync(join(value.dataDir, 'workspaces', value.tenant.id, value.project.id, run.id)),
    ).toBe(false);
  });

  // PGlite 为进程内 WASM，并行跑全量测试时 CPU 竞争明显，这里放宽测试超时；用例自身仍断言 15 分钟 SLA。
  it('runs 50 API scenarios well under 15 minutes', async () => {
    const value = await fixture({ apiConcurrency: 4 });
    const caseKeys = Array.from(
      { length: 50 },
      (_entry, index) => `PERF-${String(index + 1).padStart(3, '0')}`,
    );
    const run = await value.createRun({ type: 'cases', modules: [], caseKeys });
    const executor = await execute(value, run.id);
    const result = await runStages(executor);

    await executor.close();

    expect(result.outcome).toBe('completed');
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);
    const stats = JSON.parse(stored?.statsJson ?? '{}') as {
      total: number;
      passed: number;
      failed: number;
      durationMs: number;
    };

    expect(stored?.status).toBe('succeeded');
    expect(stats).toMatchObject({ total: 50, passed: 50, failed: 0 });
    expect(stats.durationMs).toBeLessThan(15 * 60_000);
  }, 60_000);

  it('fails fast when the environment is unreachable', async () => {
    const value = await fixture();
    const environment = await new EnvironmentRepository(value.database.db, value.tenant.id).create({
      projectId: value.project.id,
      name: 'unreachable',
      apiBaseUrl: 'http://127.0.0.1:1',
      healthcheckUrl: 'http://127.0.0.1:1/healthz',
      healthcheckExpectedStatus: 200,
      healthcheckTimeoutMs: 300,
      versionSource: 'manual',
      deployedSha: value.headSha,
      strictVersionMatch: false,
      envVarsJson: '{}',
      browserJson: '{}',
      caseTimeoutMs: 2_000,
      apiConcurrency: 2,
      uiConcurrency: 1,
      isDefault: false,
    });
    const run = await new RunRepository(value.database.db, value.tenant.id).create({
      projectId: value.project.id,
      environmentId: environment.id,
      headSha: value.headSha,
      selection: { type: 'all', modules: [], caseKeys: [] },
      idempotencyKey: 'unreachable-run',
    });
    const executor = await execute(value, run.id);
    const result = await runStages(executor);

    await executor.close();

    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('ENV_UNHEALTHY');
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);
    const error = JSON.parse(stored?.errorJson ?? '{}') as {
      code: string;
      classification?: string;
    };

    expect(stored?.status).toBe('failed');
    expect(error.code).toBe('ENV_UNHEALTHY');
    expect(error.classification).toBe('env_issue');
    expect(
      await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(run.id),
    ).toHaveLength(0);
  });

  it('cancels a running HTTP step and marks the case skipped', async () => {
    const value = await fixture({ apiConcurrency: 1 });
    const suiteRoot = join(value.dataDir, 'suites', value.project.id);

    write(
      suiteRoot,
      'features/api/slow.feature',
      [
        '@module:slow @layer:api',
        'Feature: Slow API',
        '',
        '  @case:SLOW-001',
        '  Scenario: slow request',
        '    When I send a GET request to "/api/slow"',
        '    Then the response status should be 200',
      ].join('\n'),
    );
    await runGit(['add', '-A'], { cwd: suiteRoot });
    await runGit(['commit', '-m', 'test: slow scenario'], { cwd: suiteRoot });

    const run = await value.createRun({ type: 'cases', modules: [], caseKeys: ['SLOW-001'] });
    const executor = await execute(value, run.id, {
      cancelPollIntervalMs: 20,
      runTimeoutMs: 20_000,
    });
    const execution = runStages(executor);
    const repository = new RunRepository(value.database.db, value.tenant.id);
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const current = await repository.findById(run.id);

      if (current?.status === 'running') {
        const cases = await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(
          run.id,
        );

        if (cases.some((runCase) => runCase.status === 'running')) {
          await repository.update(run.id, { status: 'canceled', finishedAt: Date.now() });
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const result = await execution;

    await executor.close();

    expect(result.outcome).toBe('canceled');
    const stored = await repository.findById(run.id);

    expect(stored?.status).toBe('canceled');
    const cases = await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(run.id);

    expect(cases).toHaveLength(1);
    expect(cases[0]?.status).toBe('skipped');
  });

  it('does not overwrite a cancellation that lands during prepare', async () => {
    const value = await fixture();
    const run = await value.createRun({ type: 'all', modules: [], caseKeys: [] });
    const repository = new RunRepository(value.database.db, value.tenant.id);

    await repository.update(run.id, { status: 'canceled', finishedAt: Date.now() });
    const executor = await execute(value, run.id);
    const result = await executor.prepareWorkspace();

    expect(result.ok).toBe(false);
    expect(result.canceled).toBe(true);
    expect(result.code).toBe('RUN_CANCELED');
    expect((await repository.findById(run.id))?.status).toBe('canceled');
    await executor.close();
  });

  it('rebuilds the workspace when resuming after a checkpoint', async () => {
    const value = await fixture();
    const run = await value.createRun({ type: 'cases', modules: [], caseKeys: ['RUN-API-001'] });
    const executor = await execute(value, run.id);

    // 模拟 Graph B 已 checkpoint 但新进程没有工作区：跳过 prepare 直接继续。
    await expect(executor.verifyEnvironment()).resolves.toMatchObject({ ok: true });
    await expect(executor.prepareTestData()).resolves.toMatchObject({ ok: true });
    await expect(executor.discoverCases()).resolves.toMatchObject({ ok: true });
    await expect(executor.runCases()).resolves.toMatchObject({ ok: true });
    await executor.aggregate();
    await executor.close();

    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);

    expect(stored?.status).toBe('succeeded');
  });

  it('reruns a failed case once and records flaky evidence', async () => {
    const value = await fixture();
    const suiteRoot = join(value.dataDir, 'suites', value.project.id);
    const feature = [
      '@module:flaky @layer:api',
      'Feature: Flaky API',
      '',
      '  @case:RUN-FLAKY-001',
      '  Scenario: flaky endpoint',
      '    When I send a GET request to "/api/flaky"',
      '    Then the response status should be 200',
    ].join('\n');

    write(suiteRoot, 'features/api/flaky.feature', feature);
    await runGit(['add', '-A'], { cwd: suiteRoot });
    await runGit(['commit', '-m', 'test: flaky scenario'], { cwd: suiteRoot });
    const run = await value.createRun({
      type: 'cases',
      modules: [],
      caseKeys: ['RUN-FLAKY-001'],
    });
    const executor = await execute(value, run.id);

    expect((await executor.prepareWorkspace()).ok).toBe(true);
    expect((await executor.verifyEnvironment()).ok).toBe(true);
    expect((await executor.prepareTestData()).ok).toBe(true);
    expect((await executor.discoverCases()).ok).toBe(true);
    const first = await executor.runCases();
    const before = await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(
      run.id,
    );

    expect(first.ok).toBe(true);
    expect(before[0]?.status).toBe('failed');
    expect(before[0]?.attempt).toBe(1);

    const rerun = await executor.rerunFailedCases();
    const after = await new RunCaseRepository(value.database.db, value.tenant.id).listByRun(run.id);
    const evidence = JSON.parse(after[0]?.evidenceJson ?? '{}') as {
      rerun?: { attempted?: boolean; passed?: boolean; previousStatus?: string };
    };

    expect(rerun.ok).toBe(true);
    expect(after[0]?.status).toBe('passed');
    expect(after[0]?.attempt).toBe(2);
    expect(after[0]?.classification).toBe('flaky');
    expect(evidence.rerun?.attempted).toBe(true);
    expect(evidence.rerun?.passed).toBe(true);
    expect(evidence.rerun?.previousStatus).toBe('failed');

    await executor.aggregate();
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);
    const stats = JSON.parse(stored?.statsJson ?? '{}') as {
      flaky?: number;
      classifications?: { flaky?: number };
    };

    expect(stored?.status).toBe('succeeded');
    expect(stats.flaky).toBe(1);
    expect(stats.classifications?.flaky).toBe(1);
    await executor.close();
  });

  it('executes a real Chromium UI scenario end to end', async () => {
    const value = await fixture();
    let probe;

    try {
      probe = await PlaywrightUiDriver.launch({ headless: true });
      await probe.close();
    } catch (error) {
      console.warn(`Chromium unavailable, skipping real UI run: ${String(error)}`);
      return;
    }

    const suiteRoot = join(value.dataDir, 'suites', value.project.id);

    write(
      suiteRoot,
      'features/ui/real.feature',
      [
        '@module:ui @layer:ui',
        'Feature: Real UI',
        '',
        '  @case:UI-REAL-001',
        '  Scenario: real page',
        '    Given I am on the "/ui" page',
        '    Then the page should contain "Welcome to Demo"',
      ].join('\n'),
    );
    await runGit(['add', '-A'], { cwd: suiteRoot });
    await runGit(['commit', '-m', 'test: real ui scenario'], { cwd: suiteRoot });

    const run = await value.createRun({ type: 'cases', modules: [], caseKeys: ['UI-REAL-001'] });
    const executor = await execute(value, run.id, {
      uiDriverFactory: (options) => PlaywrightUiDriver.launch(options),
    });
    const result = await runStages(executor);

    await executor.close();

    expect(result.outcome).toBe('completed');
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);

    expect(stored?.status).toBe('succeeded');
    const artifacts = await new ArtifactRepository(value.database.db, value.tenant.id).listByRun(
      run.id,
    );

    expect(artifacts.some((artifact) => artifact.type === 'screenshot')).toBe(true);
    expect(artifacts.some((artifact) => artifact.type === 'trace')).toBe(true);
  }, 30_000);

  it('executes UI scenarios with screenshots and trace artifacts', async () => {
    const value = await fixture();
    const suiteRoot = join(value.dataDir, 'suites', value.project.id);

    write(
      suiteRoot,
      'features/ui/login.feature',
      [
        '@module:ui @layer:ui',
        'Feature: UI',
        '',
        '  @case:UI-RUN-001',
        '  Scenario: open page',
        '    Given I am on the "/login" page',
        '    Then the page should contain "Welcome"',
      ].join('\n'),
    );
    await runGit(['add', '-A'], { cwd: suiteRoot });
    await runGit(['commit', '-m', 'test: ui scenario'], { cwd: suiteRoot });

    const run = await value.createRun({ type: 'cases', modules: [], caseKeys: ['UI-RUN-001'] });
    const executor = await execute(value, run.id, {
      uiDriverFactory: async () => new StaticUiDriver(),
    });
    const result = await runStages(executor);

    await executor.close();

    expect(result.outcome).toBe('completed');
    const stored = await new RunRepository(value.database.db, value.tenant.id).findById(run.id);
    const stats = JSON.parse(stored?.statsJson ?? '{}') as { total: number; passed: number };

    expect(stored?.status).toBe('succeeded');
    expect(stats).toMatchObject({ total: 1, passed: 1 });

    const artifacts = await new ArtifactRepository(value.database.db, value.tenant.id).listByRun(
      run.id,
    );

    expect(artifacts.some((artifact) => artifact.type === 'screenshot')).toBe(true);
    expect(artifacts.some((artifact) => artifact.type === 'trace')).toBe(true);
    expect(artifacts.some((artifact) => artifact.type === 'console')).toBe(true);
  });
});
