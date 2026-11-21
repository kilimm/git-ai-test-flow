// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, loadEnv } from '../../packages/config/dist/index.js';
import {
  ArtifactRepository,
  DocRepository,
  EnvironmentRepository,
  FeatureIndexRepository,
  GenerationFileRepository,
  GenerationRepository,
  MembershipRepository,
  NotificationRepository,
  openDatabase,
  ProjectRepository,
  RunCaseRepository,
  RunRepository,
  StepResultRepository,
  TenantRepository,
  UserRepository,
  runMigrations,
} from '../../packages/db/dist/index.js';
import { runGit } from '../../packages/git/dist/index.js';

const PASSWORD = 'E2E-Password-123';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

async function createSuiteRepo(root: string): Promise<{ path: string; headSha: string }> {
  // SuiteRepository 会向 suite repo push，因此测试远端必须是 bare 仓库。
  const work = join(root, 'repos', 'suite-seed');
  const bare = join(root, 'repos', 'suite-demo.git');

  mkdirSync(work, { recursive: true });
  mkdirSync(bare, { recursive: true });
  await runGit(['init', '-b', 'main'], { cwd: work });
  await runGit(['config', 'user.email', 'e2e@example.com'], { cwd: work });
  await runGit(['config', 'user.name', 'E2E Seed'], { cwd: work });
  write(work, 'README.md', '# E2E Suite\n');
  await runGit(['add', '-A'], { cwd: work });
  await runGit(['commit', '-m', 'chore: seed suite'], { cwd: work });
  const headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();

  await runGit(['init', '--bare'], { cwd: bare });
  await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bare });
  await runGit(['push', bare, 'HEAD:refs/heads/main'], { cwd: work });

  return { path: bare, headSha };
}

/**
 * E2E 种子数据：两个租户、三个用户、可审批的生成草稿、已完成的失败 Run、
 * 用例索引与截图产物。所有数据写入 DATA_DIR 下独立测试库，不触碰正式数据。
 */
export async function seedE2E(): Promise<void> {
  const env = loadEnv();
  const dataDir = env.DATA_DIR;

  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(join(dataDir, 'artifacts'), { recursive: true });

  const suite = await createSuiteRepo(dataDir);
  const database = openDatabase({ path: env.DATABASE_PATH });

  try {
    runMigrations(database);
    const users = new UserRepository(database.db);
    const passwordHash = await hashPassword(PASSWORD);
    const owner = users.create({
      username: 'e2e-owner',
      passwordHash,
      displayName: 'E2E Owner',
      isPlatformAdmin: true,
    });
    const betaOwner = users.create({
      username: 'e2e-beta',
      passwordHash,
      displayName: 'Beta Owner',
    });
    const viewer = users.create({
      username: 'e2e-viewer',
      passwordHash,
      displayName: 'E2E Viewer',
    });
    const acme = new TenantRepository(database.db).create({
      slug: 'acme',
      name: 'Acme E2E',
    });
    const beta = new TenantRepository(database.db).create({
      slug: 'beta',
      name: 'Beta E2E',
    });

    new MembershipRepository(database.db, acme.id).add({ userId: owner.id, role: 'owner' });
    new MembershipRepository(database.db, acme.id).add({ userId: viewer.id, role: 'viewer' });
    new MembershipRepository(database.db, beta.id).add({ userId: betaOwner.id, role: 'owner' });

    const project = new ProjectRepository(database.db, acme.id).create({
      id: 'project-e2e-demo',
      name: 'Demo App',
      slug: 'demo',
      productRepoUrl: suite.path,
      defaultBranch: 'main',
      suiteMode: 'external',
      suiteRepoUrl: suite.path,
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });
    new ProjectRepository(database.db, beta.id).create({
      name: 'Beta App',
      slug: 'beta-app',
      productRepoUrl: 'https://example.com/beta.git',
      defaultBranch: 'main',
      suiteMode: 'managed',
      featureRoot: 'features/',
      docsRoot: 'docs/ai/',
    });

    const environment = new EnvironmentRepository(database.db, acme.id).create({
      id: 'env-e2e-staging',
      projectId: project.id,
      name: 'staging',
      apiBaseUrl: 'http://127.0.0.1:3100',
      webBaseUrl: 'http://127.0.0.1:3100',
      healthcheckUrl: 'http://127.0.0.1:3100/healthz',
      healthcheckExpectedStatus: 200,
      healthcheckTimeoutMs: 5_000,
      versionSource: 'manual',
      deployedSha: suite.headSha,
      strictVersionMatch: false,
      envVarsJson: '{}',
      browserJson: '{}',
      caseTimeoutMs: 30_000,
      apiConcurrency: 2,
      uiConcurrency: 1,
      isDefault: true,
    });

    const featureContent = [
      '@module:posts @layer:api',
      'Feature: Posts API',
      '',
      '  @case:E2E-API-001',
      '  Scenario: list posts',
      '    When I send a GET request to "/api/items"',
      '    Then the response status should be 200',
    ].join('\n');

    new FeatureIndexRepository(database.db, acme.id).indexFeatureFile({
      projectId: project.id,
      repo: 'suite',
      path: 'features/api/posts.feature',
      blobSha: null,
      moduleKey: 'posts',
      tags: ['module:posts', 'layer:api'],
      scenarios: [
        {
          caseKey: 'E2E-API-001',
          name: 'list posts',
          line: 4,
          tags: ['case:E2E-API-001', 'module:posts', 'layer:api'],
          contentHash: sha256(featureContent),
          fingerprint: sha256('post-list'),
          searchText: 'list posts posts api GET /api/items',
        },
      ],
    });

    const docs = new DocRepository(database.db, acme.id);
    const docModule = docs.upsertModule({
      projectId: project.id,
      key: 'posts',
      name: '帖子模块',
      description: '帖子列表、分页与创建接口。',
      pathPatterns: ['src/api/posts.ts', 'src/pages/posts/**'],
      owner: 'content-team',
      dependsOn: ['auth'],
    });

    docs.createVersion({
      projectId: project.id,
      docModuleId: docModule.id,
      commitSha: suite.headSha,
      contentMd: [
        '# 帖子模块',
        '',
        '> 模块 key：`posts` · 负责人：content-team',
        '',
        '## 模块职责',
        '',
        '提供帖子列表、分页与创建接口。',
        '',
        '## 对外接口',
        '',
        '- `GET /api/items`',
        '- `POST /api/items`',
        '',
        '## 变更历史',
        '',
        `- ${suite.headSha.slice(0, 8)} feat: seed posts API`,
        '',
      ].join('\n'),
      contentHash: sha256('seed-posts-doc'),
      summary: 'E2E 文档种子',
      status: 'committed',
      humanEdited: false,
      tokenCount: 42,
    });
    docs.upsertEntry({
      projectId: project.id,
      commitSha: suite.headSha,
      committedAt: Date.now() - 60_000,
      author: 'E2E Seed',
      title: 'feat: seed posts API',
      summaryMd: '新增帖子列表分页接口。',
      detailMd: '文件：src/api/posts.ts',
      files: ['src/api/posts.ts', 'src/pages/posts.tsx'],
      modules: ['posts'],
      tokenCount: 18,
    });
    docs.updateSyncState(project.id, {
      lastProcessedSha: suite.headSha,
      lastDocCommitSha: suite.headSha,
    });

    const generationRepository = new GenerationRepository(database.db, acme.id);
    const generation = generationRepository.create({
      id: 'gen-e2e-awaiting',
      projectId: project.id,
      baseSha: suite.headSha,
      headSha: suite.headSha,
      branch: 'main',
      mode: 'range',
      trigger: 'manual',
      status: 'awaiting_approval',
      idempotencyKey: 'e2e-generation-1',
      model: 'fake-model',
      promptVersion: 'test',
      createdByUserId: owner.id,
      statsJson: JSON.stringify({ featurePoints: 1, filesIncluded: 2, tokenUsage: {} }),
    });

    generationRepository.update(
      generation.id,
      {
        approvalStatus: 'pending',
        featurePointsJson: JSON.stringify([
          {
            id: 'FP-001',
            title: '帖子列表分页',
            description: '帖子列表新增分页参数，需要验证默认页与越界页码。',
            kind: 'api',
            risk: 'medium',
            affectedModules: ['posts'],
            sources: [
              {
                path: 'src/api/posts.ts',
                hunk: '@@ -10,6 +10,12 @@',
                reason: '新增分页参数',
              },
            ],
            docRefs: [],
            existingCoverage: [],
            suggestedLayer: ['api'],
          },
        ]),
      },
      Date.now(),
    );
    new GenerationFileRepository(database.db, acme.id).replaceForGeneration(generation.id, [
      {
        path: 'features/api/posts.feature',
        action: 'create',
        content: featureContent,
        contentHash: sha256(featureContent),
        scenarioCount: 1,
        validationStatus: 'valid',
      },
    ]);

    const runRepository = new RunRepository(database.db, acme.id);
    const run = runRepository.create({
      id: 'run-e2e-failed',
      projectId: project.id,
      environmentId: environment.id,
      baseSha: suite.headSha,
      headSha: suite.headSha,
      deployedSha: suite.headSha,
      versionMatch: true,
      branch: 'main',
      trigger: 'manual',
      status: 'failed',
      idempotencyKey: 'e2e-run-1',
      createdByUserId: owner.id,
      statsJson: JSON.stringify({
        total: 1,
        passed: 0,
        failed: 1,
        error: 0,
        skipped: 0,
        flaky: 0,
        quarantined: 0,
        classifications: { code_bug: 1, test_bug: 0, env_issue: 0, flaky: 0, unknown: 0 },
        durationMs: 4_200,
        analysis: { rule: 1, llm: 0, fallback: 0, llmInputTokens: 0, llmOutputTokens: 0 },
      }),
      errorJson: null,
    });
    const runCaseRepository = new RunCaseRepository(database.db, acme.id);
    const runCase = runCaseRepository.createMany([
      {
        id: 'runcase-e2e-001',
        runId: run.id,
        featurePath: 'features/api/posts.feature',
        scenarioName: 'list posts',
        line: 4,
        caseKey: 'E2E-API-001',
        tags: ['module:posts', 'layer:api', 'case:E2E-API-001'],
        layer: 'api',
        status: 'failed',
      },
    ])[0];

    if (runCase === undefined) {
      throw new Error('E2E run case seed failed');
    }

    const attribution = {
      verdict: 'code_bug',
      confidence: 0.82,
      rootCause: '分页参数为空时接口返回 500，应在入口校验并返回 400。',
      evidenceRefs: ['step:2', 'diff:src/api/posts.ts:42'],
      suggestedFix: null,
      testRepairAllowed: false,
      source: 'rule',
      conflict: null,
    };
    runCaseRepository.update(runCase.id, {
      classification: 'code_bug',
      confidence: 82,
      durationMs: 4_200,
      errorMessage: 'expected 400 but received 500',
      startedAt: Date.now() - 5_000,
      finishedAt: Date.now(),
      repairStatus: null,
      evidenceJson: JSON.stringify({
        errorCode: 'EXPECTED_STATUS',
        rerun: {
          attempted: true,
          previousStatus: 'failed',
          previousErrorCode: 'EXPECTED_STATUS',
          passed: false,
          durationMs: 4_100,
        },
        attribution,
        evidence: {
          version: 1,
          collectedAt: Date.now(),
          failedStepIndex: 2,
          steps: [
            {
              index: 1,
              keyword: 'When',
              text: 'I send a GET request to "/api/items"',
              type: 'api',
              status: 'passed',
              durationMs: 120,
              error: null,
              output: { status: 500 },
            },
            {
              index: 2,
              keyword: 'Then',
              text: 'the response status should be 200',
              type: 'api',
              status: 'failed',
              durationMs: 80,
              error: { code: 'EXPECTED_STATUS', message: 'expected 200 but received 500' },
              output: { status: 500 },
            },
          ],
          logs: [],
          history: [],
          diff: {
            available: true,
            files: [
              {
                path: 'src/api/posts.ts',
                status: 'modified',
                category: 'api',
                hunks: [
                  {
                    header: '@@ -40,7 +40,9 @@',
                    content:
                      ' export function listPosts(page: number) {\n+  if (!page) {\n+    throw new Error("page required");\n',
                  },
                ],
              },
            ],
            testFilesChanged: false,
          },
          codeLocations: [
            {
              path: 'src/api/posts.ts',
              line: 42,
              reason: '失败步骤涉及 /api/items，与本次变更文件相关',
              confidence: 0.7,
            },
          ],
          signals: {
            endpoints: ['/api/items'],
            selectors: [],
            selectorChanged: false,
            testFilesChanged: false,
            productFilesChanged: true,
            codeTouchConfidence: 0.7,
          },
        },
      }),
    });
    new StepResultRepository(database.db, acme.id).create({
      id: 'step-e2e-001',
      runCaseId: runCase.id,
      stepIndex: 2,
      keyword: 'Then',
      text: 'the response status should be 200',
      type: 'api',
      status: 'failed',
      durationMs: 80,
      error: { code: 'EXPECTED_STATUS', message: 'expected 200 but received 500' },
      output: { expected: 200, actual: 500 },
    });

    const artifactPath = 'artifacts/acme/run-e2e-failed/runcase-e2e-001/failure.png';
    const artifactAbsolute = join(dataDir, artifactPath);

    mkdirSync(join(artifactAbsolute, '..'), { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==',
      'base64',
    );

    writeFileSync(artifactAbsolute, png);
    new ArtifactRepository(database.db, acme.id).create({
      runId: run.id,
      runCaseId: runCase.id,
      type: 'screenshot',
      path: artifactPath,
      mime: 'image/png',
      size: png.byteLength,
      sha256: createHash('sha256').update(png).digest('hex'),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
      metadata: { label: 'failure' },
    });
    new NotificationRepository(database.db, acme.id).create({
      projectId: project.id,
      runId: run.id,
      eventType: 'run_failed',
      status: 'sent',
      dedupeKey: `${run.id}:e2e-channel:run_failed`,
      now: Date.now(),
    });

    writeFileSync(
      join(dataDir, 'seed.json'),
      JSON.stringify(
        {
          tenant: acme.slug,
          betaTenant: beta.slug,
          project: project.slug,
          generationId: generation.id,
          runId: run.id,
          runCaseId: runCase.id,
          password: PASSWORD,
        },
        null,
        2,
      ),
      'utf8',
    );
  } finally {
    database.close();
  }
}
