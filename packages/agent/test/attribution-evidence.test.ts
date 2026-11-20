// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import {
  ArtifactRepository,
  NotificationRepository,
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunRepository,
  StepResultRepository,
  TenantRepository,
} from '@gait/db';
import type { Project, Run, RunCase, Tenant } from '@gait/db';
import type { DiffFile } from '@gait/shared';
import { buildCaseEvidence, evidenceRefs } from '../src/attribution/evidence.js';
import { analyzeRun } from '../src/attribution/analyze.js';
import {
  buildRunReport,
  renderReportHtml,
  renderReportJUnit,
  renderReportMarkdown,
} from '../src/report/report-builder.js';
import type { LlmClient } from '../src/llm/llm-client.js';

interface Fixture {
  database: TestDatabase;
  dataDir: string;
  tenant: Tenant;
  project: Project;
  run: Run;
  runCase: RunCase;
  runRepository: RunRepository;
  caseRepository: RunCaseRepository;
  stepRepository: StepResultRepository;
  artifactRepository: ArtifactRepository;
}

const databases: TestDatabase[] = [];
const dataDirs: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }

  for (const directory of dataDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedBase(headSha = 'a'.repeat(40)): Fixture {
  const database = createTestDatabase();
  const dataDir = mkdtempSync(join(tmpdir(), 'gait-evidence-'));
  databases.push(database);
  dataDirs.push(dataDir);
  const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://example.com/demo.git',
    defaultBranch: 'main',
    suiteMode: 'external',
    suiteRepoUrl: 'https://example.com/suite.git',
    featureRoot: 'features/',
    docsRoot: 'docs/',
  });
  const runRepository = new RunRepository(database.db, tenant.id);
  const run = runRepository.create({
    projectId: project.id,
    baseSha: 'b'.repeat(40),
    headSha,
    branch: 'main',
    status: 'running',
    idempotencyKey: `run:${headSha}:${Math.random()}`,
  });
  const caseRepository = new RunCaseRepository(database.db, tenant.id);
  const runCase = caseRepository.createMany([
    {
      runId: run.id,
      featurePath: 'features/api/posts.feature',
      scenarioName: 'create post',
      caseKey: 'POST-001',
      tags: ['module:posts', 'layer:api'],
      layer: 'api',
    },
  ])[0] as RunCase;

  caseRepository.update(runCase.id, {
    status: 'failed',
    errorMessage: 'expected 400 but received 500',
  });

  return {
    database,
    dataDir,
    tenant,
    project,
    run,
    runCase,
    runRepository,
    caseRepository,
    stepRepository: new StepResultRepository(database.db, tenant.id),
    artifactRepository: new ArtifactRepository(database.db, tenant.id),
  };
}

function diffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/api/posts.ts',
    oldPath: null,
    status: 'modified',
    category: 'api',
    binary: false,
    isDoc: false,
    isTest: false,
    isOpenApi: false,
    isSensitive: false,
    skipped: false,
    skipReason: null,
    truncated: false,
    sizeBytes: 100,
    additions: 2,
    deletions: 1,
    patch: '',
    hunks: [
      {
        header: '@@ -40,7 +40,9 @@',
        oldStart: 40,
        oldLines: 7,
        newStart: 40,
        newLines: 9,
        content: [
          ' export function createPost(title: string) {',
          '+  if (title.length === 0) {',
          '+    throw new Error("title required");',
          '   return repository.create(title);',
        ].join('\n'),
      },
    ],
    ...overrides,
  };
}

function writeArtifact(fixture: Fixture, content: string): void {
  const absolute = join(
    fixture.dataDir,
    'artifacts',
    'acme',
    fixture.run.id,
    fixture.runCase.id,
    'console.txt',
  );

  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  fixture.artifactRepository.create({
    runId: fixture.run.id,
    runCaseId: fixture.runCase.id,
    type: 'console',
    path: relative(fixture.dataDir, absolute).split(sep).join('/'),
    mime: 'text/plain',
    size: Buffer.byteLength(content),
    sha256: 'c'.repeat(64),
  });
}

function failedStep(fixture: Fixture, overrides: Record<string, unknown> = {}): void {
  fixture.stepRepository.create({
    runCaseId: fixture.runCase.id,
    stepIndex: 1,
    keyword: 'Then',
    text: 'the response status should be 400 for /api/posts',
    type: 'api',
    status: 'failed',
    durationMs: 20,
    error: {
      code: 'EXPECTED_STATUS',
      message: 'expected 400 but received 500; Authorization: Bearer abcdefghijklmnop',
    },
    output: {
      request: { headers: { authorization: 'Bearer abcdefghijklmnop' } },
      response: { status: 500, body: { password: 'super-secret' } },
    },
    ...overrides,
  });
}

function seedHistory(fixture: Fixture, passed: boolean): void {
  const oldRun = fixture.runRepository.create({
    projectId: fixture.project.id,
    headSha: 'd'.repeat(40),
    status: passed ? 'succeeded' : 'failed',
    idempotencyKey: `old:${Math.random()}`,
  });
  const oldCase = fixture.caseRepository.createMany([
    {
      runId: oldRun.id,
      featurePath: fixture.runCase.featurePath,
      scenarioName: fixture.runCase.scenarioName,
      caseKey: fixture.runCase.caseKey,
      tags: ['module:posts', 'layer:api'],
      layer: 'api',
      status: passed ? 'passed' : 'failed',
    },
  ])[0];

  if (oldCase === undefined) {
    throw new Error('history case was not created');
  }
}

describe('证据包构建', () => {
  it('收集步骤、历史、diff、日志并完成脱敏', async () => {
    const fixture = seedBase();
    failedStep(fixture);
    writeArtifact(fixture, 'console: Bearer abcdefghijklmnop\n{"token":"abcdefghijklmnop"}');
    seedHistory(fixture, true);

    const pack = await buildCaseEvidence({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      runCaseId: fixture.runCase.id,
      dataDir: fixture.dataDir,
      diff: [diffFile()],
    });

    expect(pack.failedStepIndex).toBe(1);
    expect(pack.steps).toHaveLength(1);
    expect(pack.steps[0]?.error?.message).not.toContain('abcdefghijklmnop');
    expect(pack.steps[0]?.error?.message).toContain('****');
    expect(pack.steps[0]?.output).toMatchObject({
      request: { headers: { authorization: '****' } },
      response: { body: { password: '****' } },
    });
    expect(pack.logs).toHaveLength(1);
    expect(pack.logs[0]?.tail).not.toContain('abcdefghijklmnop');
    expect(pack.history).toHaveLength(1);
    expect(pack.history[0]?.caseStatus).toBe('passed');
    expect(pack.diff.available).toBe(true);
    expect(pack.signals.endpoints).toContain('/api/posts');
    expect(pack.codeLocations[0]?.path).toBe('src/api/posts.ts');
    expect(pack.redacted).toBe(true);
    expect(evidenceRefs(pack)).toEqual(
      expect.arrayContaining(['step:1', 'diff:src/api/posts.ts', 'environment']),
    );
  });

  it('读取 run_case 中保存的重跑结果', async () => {
    const fixture = seedBase();
    failedStep(fixture);
    fixture.caseRepository.update(fixture.runCase.id, {
      evidenceJson: JSON.stringify({
        rerun: {
          attempted: true,
          previousStatus: 'failed',
          previousErrorCode: 'EXPECTED_STATUS',
          passed: false,
          durationMs: 33,
        },
      }),
    });

    const pack = await buildCaseEvidence({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      runCaseId: fixture.runCase.id,
      dataDir: fixture.dataDir,
      diff: null,
    });

    expect(pack.rerun?.attempted).toBe(true);
    expect(pack.rerun?.passed).toBe(false);
    expect(pack.diff.available).toBe(false);
  });

  it('归因后写入分类、证据与修复建议', async () => {
    const fixture = seedBase();
    failedStep(fixture, {
      type: 'ui',
      text: 'I click "old-login" button',
      error: { code: 'LOCATOR_TIMEOUT', message: 'waiting for selector "old-login"' },
    });
    const diff = [
      diffFile({
        path: 'src/pages/login.tsx',
        category: 'frontend',
        hunks: [
          {
            header: '@@ -10,6 +10,6 @@',
            oldStart: 10,
            oldLines: 6,
            newStart: 10,
            newLines: 6,
            content: [
              ' export function Login() {',
              '-  return <button id="old-login">Login</button>;',
              '+  return <button data-testid="login-submit">Login</button>;',
              ' }',
            ].join('\n'),
          },
        ],
      }),
    ];
    const summary = await analyzeRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      dataDir: fixture.dataDir,
      diff,
      readSuiteFile: () => 'Feature: login',
      now: () => 1_000,
    });
    const updated = fixture.caseRepository.findById(fixture.runCase.id);
    const evidence = JSON.parse(updated?.evidenceJson ?? '{}') as {
      evidence?: { signals?: { selectorChanged?: boolean } };
      attribution?: { verdict?: string; evidenceRefs?: string[] };
    };
    const repairs = new RepairAttemptRepository(
      fixture.database.db,
      fixture.tenant.id,
    ).listByRunCase(fixture.runCase.id);

    expect(summary.analyzed).toBe(1);
    expect(updated?.classification).toBe('test_bug');
    expect(evidence.attribution?.verdict).toBe('test_bug');
    expect(evidence.evidence?.signals?.selectorChanged).toBe(true);
    expect(updated?.repairStatus).toBe('human_required');
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.guardStatus).toBe('human_required');
  });

  it('历史通过时规则判定 code_bug 且禁止修复', async () => {
    const fixture = seedBase();
    failedStep(fixture);
    seedHistory(fixture, true);

    await analyzeRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      dataDir: fixture.dataDir,
      diff: [],
      now: () => 1_000,
    });
    const updated = fixture.caseRepository.findById(fixture.runCase.id);
    const repairs = new RepairAttemptRepository(
      fixture.database.db,
      fixture.tenant.id,
    ).listByRunCase(fixture.runCase.id);

    expect(updated?.classification).toBe('code_bug');
    expect(repairs).toHaveLength(0);
    expect(updated?.repairStatus).toBeNull();
  });

  it('同一 Run 中区分代码 Bug 与用例 Bug', async () => {
    const fixture = seedBase();
    failedStep(fixture);
    seedHistory(fixture, true);
    const uiCase = fixture.caseRepository.createMany([
      {
        runId: fixture.run.id,
        featurePath: 'features/ui/login.feature',
        scenarioName: 'login',
        caseKey: 'UI-001',
        tags: ['module:login', 'layer:ui'],
        layer: 'ui',
        status: 'failed',
      },
    ])[0];

    if (uiCase === undefined) {
      throw new Error('UI case seed failed');
    }

    fixture.stepRepository.create({
      runCaseId: uiCase.id,
      stepIndex: 1,
      keyword: 'When',
      text: 'I click "old-login" button',
      type: 'ui',
      status: 'failed',
      error: { code: 'LOCATOR_TIMEOUT', message: 'waiting for selector "old-login"' },
    });
    const diff = [
      diffFile(),
      diffFile({
        path: 'src/pages/login.tsx',
        category: 'frontend',
        hunks: [
          {
            header: '@@ -10,6 +10,6 @@',
            oldStart: 10,
            oldLines: 6,
            newStart: 10,
            newLines: 6,
            content: [
              ' export function Login() {',
              '-  return <button id="old-login">Login</button>;',
              '+  return <button data-testid="login-submit">Login</button>;',
              ' }',
            ].join('\n'),
          },
        ],
      }),
    ];

    await analyzeRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      dataDir: fixture.dataDir,
      diff,
      now: () => 2_000,
    });
    const cases = fixture.caseRepository.listByRun(fixture.run.id);
    const apiCase = cases.find((item) => item.caseKey === 'POST-001');
    const updatedUiCase = cases.find((item) => item.caseKey === 'UI-001');

    expect(apiCase?.classification).toBe('code_bug');
    expect(updatedUiCase?.classification).toBe('test_bug');
    expect(updatedUiCase?.repairStatus).toBe('human_required');

    const report = buildRunReport({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      baseUrl: 'https://platform.example',
    });

    expect(report.distribution.byClassification.code_bug).toBe(1);
    expect(report.distribution.byClassification.test_bug).toBe(1);
    expect(report.failures).toHaveLength(2);
    expect(report.repairs).toHaveLength(1);
  });

  it('规则 unknown 时使用 LLM 结论并校验证据引用', async () => {
    const fixture = seedBase();
    failedStep(fixture, {
      text: 'the response status should be 400',
      error: { code: 'EXPECTED_STATUS', message: 'expected 400 but received 500' },
    });
    const llm: LlmClient = {
      async generate() {
        return {
          text: JSON.stringify({
            verdict: 'test_bug',
            confidence: 0.86,
            root_cause: '用例期望值已过期',
            evidence_refs: ['step:1'],
            suggested_fix: '更新断言期望值',
            test_repair_allowed: true,
          }),
          usage: { inputTokens: 50, outputTokens: 10, model: 'fake' },
        };
      },
    };

    await analyzeRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      dataDir: fixture.dataDir,
      diff: null,
      llm,
      llmModel: 'fake',
      now: () => 1_000,
    });
    const updated = fixture.caseRepository.findById(fixture.runCase.id);
    const evidence = JSON.parse(updated?.evidenceJson ?? '{}') as {
      attribution?: { source?: string; evidenceRefs?: string[] };
    };
    const run = fixture.runRepository.findById(fixture.run.id);
    const stats = JSON.parse(run?.statsJson ?? '{}') as {
      analysis?: { llm?: number; llmInputTokens?: number };
    };

    expect(updated?.classification).toBe('test_bug');
    expect(evidence.attribution?.source).toBe('llm');
    expect(evidence.attribution?.evidenceRefs).toEqual(['step:1']);
    expect(stats.analysis?.llm).toBe(1);
    expect(stats.analysis?.llmInputTokens).toBe(50);
  });
});

describe('报告生成', () => {
  it('输出 JSON、Markdown、HTML 与 JUnit 并包含证据链接', () => {
    const fixture = seedBase();
    failedStep(fixture);
    const attribution = {
      verdict: 'code_bug',
      confidence: 0.82,
      rootCause: '接口返回 500',
      evidenceRefs: ['step:1', 'diff:src/api/posts.ts:42'],
      suggestedFix: null,
      testRepairAllowed: false,
      source: 'rule',
      conflict: null,
    };
    fixture.caseRepository.update(fixture.runCase.id, {
      classification: 'code_bug',
      confidence: 82,
      evidenceJson: JSON.stringify({
        attribution,
        evidence: {
          version: 1,
          codeLocations: [
            {
              path: 'src/api/posts.ts',
              line: 42,
              reason: '失败步骤涉及 /api/posts',
              confidence: 0.7,
            },
          ],
        },
      }),
    });
    fixture.runRepository.update(fixture.run.id, {
      status: 'failed',
      finishedAt: 2_000,
      statsJson: JSON.stringify({
        total: 1,
        passed: 0,
        failed: 1,
        error: 0,
        skipped: 0,
        flaky: 0,
        durationMs: 1_000,
        analysis: { llmInputTokens: 10, llmOutputTokens: 2 },
      }),
    });
    new RepairAttemptRepository(fixture.database.db, fixture.tenant.id).create({
      runCaseId: fixture.runCase.id,
      attemptNo: 1,
      originalContent: 'Feature: posts',
      repairClass: 'test_update',
      rationale: '更新选择器',
      guardStatus: 'human_required',
      guardFindings: [],
    });
    new NotificationRepository(fixture.database.db, fixture.tenant.id).create({
      projectId: fixture.project.id,
      runId: fixture.run.id,
      eventType: 'run_failed',
      status: 'sent',
      dedupeKey: `${fixture.run.id}:channel:run_failed`,
    });

    const report = buildRunReport({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      baseUrl: 'https://platform.example',
      now: () => 3_000,
    });
    const markdown = renderReportMarkdown(report);
    const html = renderReportHtml(report);
    const junit = renderReportJUnit(report);

    expect(report.overview.runUrl).toContain('/t/acme/p/demo/runs/');
    expect(report.distribution.failed).toBe(1);
    expect(report.failures[0]?.classification).toBe('code_bug');
    expect(report.failures[0]?.codeLocations[0]?.path).toBe('src/api/posts.ts');
    expect(report.repairs).toHaveLength(1);
    expect(report.notifications[0]?.status).toBe('sent');
    expect(markdown).toContain('代码缺陷');
    expect(markdown).toContain('https://platform.example');
    expect(markdown).toContain('src/api/posts.ts');
    expect(html).toContain('<table>');
    expect(html).toContain('code_bug');
    expect(junit).toContain('<testsuites');
    expect(junit).toContain('create post');
    expect(junit).toContain('code_bug');
  });

  it('HTML 转义失败信息，避免注入', () => {
    const fixture = seedBase();
    failedStep(fixture, {
      error: { code: 'XSS', message: '<script>alert(1)</script>' },
    });
    fixture.caseRepository.update(fixture.runCase.id, {
      errorMessage: '<script>alert(1)</script>',
      evidenceJson: JSON.stringify({
        attribution: {
          verdict: 'unknown',
          confidence: 0.3,
          rootCause: '<script>alert(2)</script>',
          evidenceRefs: ['step:1'],
          suggestedFix: null,
          testRepairAllowed: false,
          source: 'fallback',
          conflict: null,
        },
      }),
    });

    const report = buildRunReport({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      baseUrl: 'https://platform.example',
    });
    const html = renderReportHtml(report);

    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
