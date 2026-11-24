// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  HttpExecutor,
  StepRegistry,
  parseSuiteStepCatalog,
  runScenario,
} from '../src/index.js';
import type { ScenarioRunOptions, UiDriver, StepResultSink, VisualAgent } from '../src/index.js';
import { parseFeatureSource } from '../src/index.js';

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gait-scenario-'));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeUiDriver implements UiDriver {
  readonly visualAgent?: VisualAgent;
  private url = '';
  private text = 'Welcome to Demo';
  private filled: Record<string, string> = {};
  private readonly messages: string[] = ['log: loaded'];
  private traceStarted = false;

  constructor(visualAgent?: VisualAgent) {
    if (visualAgent !== undefined) {
      this.visualAgent = visualAgent;
    }
  }

  async goto(url: string): Promise<void> {
    this.url = url;
  }

  async fill(selector: string, value: string): Promise<void> {
    this.filled[selector] = value;
  }

  async click(): Promise<void> {
    this.url = 'http://127.0.0.1/login/dashboard';
    this.text = 'Dashboard';
  }

  async isVisible(): Promise<boolean> {
    return true;
  }

  async textContent(): Promise<string | null> {
    return this.text;
  }

  async pageText(): Promise<string> {
    return this.text;
  }

  async waitForLoad(): Promise<void> {
    return;
  }

  currentUrl(): string {
    return this.url;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake-png');
  }

  async startTrace(): Promise<void> {
    this.traceStarted = true;
  }

  async stopTrace(): Promise<Buffer | null> {
    return this.traceStarted ? Buffer.from('fake-trace') : null;
  }

  consoleMessages(): readonly string[] {
    return this.messages;
  }

  getFilled(): Record<string, string> {
    return this.filled;
  }

  async close(): Promise<void> {
    return;
  }
}

function recordingSink(): {
  sink: StepResultSink;
  started: string[];
  finished: string[];
} {
  const started: string[] = [];
  const finished: string[] = [];

  return {
    started,
    finished,
    sink: {
      async start(record) {
        started.push(`${record.index}:${record.text}`);

        return `step-${record.index}`;
      },
      async finish(id, record) {
        finished.push(`${id}:${record.status}`);
      },
    },
  };
}

function options(
  featureSource: string,
  dataDir: string,
  overrides: Partial<ScenarioRunOptions> = {},
): ScenarioRunOptions {
  const parsed = parseFeatureSource(featureSource);

  if (parsed.feature === null) {
    throw new Error('invalid feature');
  }

  return {
    featurePath: 'features/ui/login.feature',
    feature: parsed.feature,
    scenario: parsed.feature.scenarios[0] as NonNullable<(typeof parsed.feature.scenarios)[0]>,
    stepRegistry: StepRegistry.createDefault(),
    environment: {
      apiBaseUrl: 'http://127.0.0.1:1',
      webBaseUrl: 'http://127.0.0.1:1',
      testAccount: { username: 'admin', password: 'secret' },
      caseTimeoutMs: 5_000,
    },
    http: new HttpExecutor({ baseUrl: 'http://127.0.0.1:1' }),
    db: null,
    suiteRoot: dataDir,
    artifacts: new ArtifactStore({
      dataDir,
      tenantId: 'tenant-1',
      runId: 'run-1',
    }),
    uiFactory: async () => new FakeUiDriver(),
    apiAgent: null,
    identity: {
      runId: 'run-1',
      runCaseId: 'case-1',
      featurePath: 'features/ui/login.feature',
      scenarioName: 'login',
      caseKey: 'UI-001',
      tags: ['layer:ui'],
      layer: 'ui',
      namespace: 'run_abcd1234_',
    },
    variableRoots: {
      env: { webBaseUrl: 'http://127.0.0.1:1' },
      fixture: {},
      secret: { testAccount: { username: 'admin', password: 'secret' } },
      var: {},
      steps: {},
      run: {},
    },
    sink: recordingSink().sink,
    ...overrides,
  };
}

const UI_FEATURE = [
  '@module:auth @layer:ui',
  'Feature: UI login',
  '  @case:UI-001',
  '  Scenario: login',
  '    Given I am on the "/login" page',
  '    When I enter my username and password',
  '    Then I should be redirected to the "/dashboard" page',
  '    And the page should contain "Dashboard"',
].join('\n');

describe('scenario runner with UI steps', () => {
  it('executes deterministic UI steps, screenshots and traces', async () => {
    const dataDir = tempDir();
    const recorder = recordingSink();
    const driver = new FakeUiDriver();
    const result = await runScenario(
      options(UI_FEATURE, dataDir, {
        uiFactory: async () => driver,
        sink: recorder.sink,
      }),
    );

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(4);
    expect(
      driver.getFilled()[
        'input[name="username"], #username, [data-testid="username"], input[type="email"]'
      ],
    ).toBe('admin');
    expect(
      result.steps.some((step) =>
        step.artifacts.some((artifact) => artifact.type === 'screenshot'),
      ),
    ).toBe(true);
    expect(result.trace?.toString()).toBe('fake-trace');
    expect(result.consoleMessages).toEqual(['log: loaded']);
    expect(recorder.started).toHaveLength(4);
    expect(recorder.finished).toHaveLength(4);
  });

  it('stops at the first failed assertion', async () => {
    const dataDir = tempDir();
    const recorder = recordingSink();
    const source = UI_FEATURE.replace('Dashboard"', 'Missing"');
    const result = await runScenario(options(source, dataDir, { sink: recorder.sink }));

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('ASSERTION_FAILED');
    expect(result.steps).toHaveLength(4);
    expect(result.failureScreenshot?.toString()).toBe('fake-png');
  });

  it('times out long scenarios and records the executed steps', async () => {
    const dataDir = tempDir();
    const source = [
      '@module:auth @layer:api',
      'Feature: Slow',
      '  @case:API-SLOW-001',
      '  Scenario: slow',
      '    When I wait 500 milliseconds',
      '    Then the test environment is ready',
    ].join('\n');
    const result = await runScenario(
      options(source, dataDir, {
        environment: {
          apiBaseUrl: 'http://127.0.0.1:1',
          webBaseUrl: null,
          testAccount: null,
          caseTimeoutMs: 50,
        },
        caseTimeoutMs: 50,
      }),
    );

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('RUN_TIMEOUT');
    expect(result.steps.length).toBeLessThanOrEqual(1);
  });

  it('executes [agent] When/Then through the injected visual agent', async () => {
    const dataDir = tempDir();
    const calls: Array<
      { mode: 'act'; instruction: string } | { mode: 'assert'; assertion: string }
    > = [];
    const driver = new FakeUiDriver({
      async act(instruction) {
        calls.push({ mode: 'act', instruction });

        return { ok: true, description: 'clicked' };
      },
      async assert(assertion) {
        calls.push({ mode: 'assert', assertion });

        return { ok: true, description: 'visible' };
      },
    });
    const source = [
      '@module:posts @layer:ui',
      'Feature: Agent',
      '  @case:AGENT-001',
      '  Scenario: agent',
      '    Given I am on the "/posts" page',
      '    When [agent] 发布一条帖子',
      '    Then [agent] 页面显示发布成功',
    ].join('\n');
    const result = await runScenario(options(source, dataDir, { uiFactory: async () => driver }));

    expect(result.status).toBe('passed');
    expect(calls).toEqual([
      { mode: 'act', instruction: '发布一条帖子' },
      { mode: 'assert', assertion: '页面显示发布成功' },
    ]);
    expect(
      result.steps
        .filter((step) => step.type === 'agent')
        .every((step) => step.artifacts.some((artifact) => artifact.type === 'screenshot')),
    ).toBe(true);
  });

  it('loads a declarative plugin step from steps/plugins', async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'steps', 'plugins'), { recursive: true });
    writeFileSync(
      join(dataDir, 'steps', 'plugins', 'echo-plugin.mjs'),
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({ plugin: true, step: payload.step }));',
        '});',
        '',
      ].join('\n'),
    );
    const source = [
      '@module:posts @layer:api',
      'Feature: Plugin',
      '  @case:PLUGIN-001',
      '  Scenario: plugin',
      '    When I run the echo plugin with "hello"',
      '    Then the test environment is ready',
    ].join('\n');
    const result = await runScenario(
      options(source, dataDir, {
        stepRegistry: StepRegistry.createDefault([
          {
            name: 'echo-plugin',
            type: 'plugin',
            pattern: 'I run the echo plugin with {string}',
          },
        ]),
      }),
    );

    expect(result.status).toBe('passed');
    expect(result.steps[0]?.type).toBe('plugin');
    expect(result.steps[0]?.output).toMatchObject({ result: { plugin: true } });
  });

  it('marks agent steps as vision-unavailable when no visual agent exists', async () => {
    const dataDir = tempDir();
    const source = [
      '@module:posts @layer:ui',
      'Feature: Agent',
      '  @case:AGENT-001',
      '  Scenario: agent',
      '    When [agent] 发布一条帖子',
      '    Then the page should contain "ok"',
    ].join('\n');
    const result = await runScenario(options(source, dataDir));

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('VISION_UNAVAILABLE');
  });
});

describe('suite script steps', () => {
  function scriptOptions(
    dataDir: string,
    script: string,
    overrides: Partial<ScenarioRunOptions> = {},
  ): ScenarioRunOptions {
    const registry = StepRegistry.createDefault(
      parseSuiteStepCatalog(
        JSON.stringify({
          steps: [
            {
              name: 'seed',
              type: 'script',
              pattern: 'I seed posts with suite script',
              script,
            },
          ],
        }),
      ),
    );
    const source = [
      '@module:posts @layer:api',
      'Feature: Script',
      '  @case:SCRIPT-001',
      '  Scenario: script',
      '    When I seed posts with suite script',
      '    Then the test environment is ready',
    ].join('\n');

    return options(source, dataDir, { stepRegistry: registry, uiFactory: null, ...overrides });
  }

  it('runs suite-managed scripts with a sanitized environment', async () => {
    const dataDir = tempDir();

    mkdirSync(join(dataDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dataDir, 'scripts', 'seed.mjs'),
      [
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const payload = JSON.parse(input);',
        '  process.stdout.write(JSON.stringify({',
        '    sawSecret: Boolean(process.env.ENCRYPTION_KEY),',
        '    namespace: payload.run.namespace,',
        '    step: payload.step,',
        '  }));',
        '});',
      ].join('\n'),
      'utf8',
    );
    const previous = process.env.ENCRYPTION_KEY;

    process.env.ENCRYPTION_KEY = 'platform-secret';

    try {
      const result = await runScenario(scriptOptions(dataDir, 'scripts/seed.mjs'));

      expect(result.status).toBe('passed');
      expect(result.steps[0]?.type).toBe('script');
      expect(result.steps[0]?.output).toMatchObject({
        script: 'seed',
        result: {
          sawSecret: false,
          namespace: 'run_abcd1234_',
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previous;
      }
    }
  });

  it('rejects scripts outside the suite root', async () => {
    const dataDir = tempDir();
    const result = await runScenario(scriptOptions(dataDir, '../escape.mjs'));

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('SUITE_PATH_INVALID');
  });

  it('kills the script process tree on cancellation', async () => {
    const dataDir = tempDir();

    mkdirSync(join(dataDir, 'scripts'), { recursive: true });
    writeFileSync(join(dataDir, 'scripts', 'slow.mjs'), 'setTimeout(() => {}, 5000);\n', 'utf8');
    const controller = new AbortController();
    const started = Date.now();
    const execution = runScenario(
      scriptOptions(dataDir, 'scripts/slow.mjs', { signal: controller.signal }),
    );

    setTimeout(() => controller.abort(), 100);
    const result = await execution;

    expect(result.status).toBe('canceled');
    expect(result.errorCode).toBe('RUN_CANCELED');
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);
});
