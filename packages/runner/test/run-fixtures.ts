// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { loadEnv } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import {
  EnvironmentRepository,
  ProjectRepository,
  RunRepository,
  TenantRepository,
} from '@gait/db';
import type { Environment, Project, Run, Tenant } from '@gait/db';
import { runGit } from '@gait/git';

export interface RunFixtureOptions {
  apiConcurrency?: number;
  versionSource?: 'header' | 'manual';
  strictVersionMatch?: boolean;
  withDatabase?: boolean;
}

export interface RunFixture {
  dataDir: string;
  dbPath: string;
  database: TestDatabase;
  env: AppEnv;
  tenant: Tenant;
  project: Project;
  environment: Environment;
  headSha: string;
  apiBaseUrl: string;
  server: Server;
  createRun(selection: unknown, key?: string): Run;
  close(): Promise<void>;
}

export function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

export async function initRepository(directory: string): Promise<string> {
  await runGit(['init', '-b', 'main'], { cwd: directory });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: directory });
  write(directory, 'README.md', '# demo product\n');
  write(directory, 'src/app.ts', 'export const app = true;\n');
  await runGit(['add', '-A'], { cwd: directory });
  await runGit(['commit', '-m', 'chore: initial'], { cwd: directory });

  return (await runGit(['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
}

export function caseFeature(count: number): string {
  const lines = ['@module:perf @layer:api', 'Feature: Perf API'];

  for (let index = 1; index <= count; index += 1) {
    lines.push(
      '',
      `  @case:PERF-${String(index).padStart(3, '0')}`,
      `  Scenario: perf ${index}`,
      '    When I send a GET request to "/api/items"',
      '    Then the response status should be 200',
      '    And the response body at "$.items[0]" should be "1"',
    );
  }

  return lines.join('\n');
}

function startApiServer(
  headSha: string,
  sqlitePath: string,
  options: { slow?: boolean } = {},
): Promise<{ server: Server; baseUrl: string }> {
  let flakyAttempts = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/healthz') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-deployed-sha': headSha,
      });
      response.end('{"status":"ok"}');
      return;
    }

    if (url.pathname === '/ui') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body><h1>Welcome to Demo</h1></body></html>');
      return;
    }

    if (url.pathname === '/api/items') {
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(request.headers['x-trace'] === undefined
          ? {}
          : { 'x-echo-trace': String(request.headers['x-trace']) }),
      });
      response.end('{"items":[1,2]}');
      return;
    }

    if (url.pathname === '/api/posts' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { title?: string };
        const database = new Database(sqlitePath);

        database.prepare('INSERT INTO posts (title) VALUES (?)').run(parsed.title ?? 'untitled');
        database.close();
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ title: parsed.title ?? 'untitled' }));
      });
      return;
    }

    if (url.pathname === '/api/flaky') {
      flakyAttempts += 1;

      if (flakyAttempts === 1) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"code":"FLAKY"}');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }

    if (url.pathname === '/api/slow') {
      setTimeout(
        () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        },
        options.slow === false ? 0 : 1_000,
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"code":"NOT_FOUND"}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        throw new Error('server did not bind');
      }

      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

export async function setupRunFixture(options: RunFixtureOptions = {}): Promise<RunFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gait-run-data-'));
  const productDir = mkdtempSync(join(tmpdir(), 'gait-run-product-'));
  const headSha = await initRepository(productDir);
  const sqlitePath = join(dataDir, 'product.db');
  const sqlite = new Database(sqlitePath);

  sqlite.pragma('journal_mode = WAL');
  sqlite.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)');
  sqlite.close();

  const api = await startApiServer(headSha, sqlitePath);
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    SSRF_ALLOWLIST: '127.0.0.1',
    DATA_DIR: dataDir,
    DATABASE_PATH: join(dataDir, 'app.db'),
  });
  const database = createTestDatabase();
  const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: productDir,
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });
  const suiteRoot = join(dataDir, 'suites', project.id);

  mkdirSync(join(suiteRoot, 'features/api'), { recursive: true });

  const feature = [
    '@module:api @layer:api',
    'Feature: API run',
    '  Background:',
    '    Given the test environment is ready',
    '',
    '  @case:RUN-API-001',
    '  Scenario: items API',
    '    When I send a GET request to "/api/items"',
    '    Then the response status should be 200',
    '    And the response body at "$.items[1]" should be "2"',
    '    And the response header "content-type" should be "application/json"',
    '    And the response body should match JSON Schema "schemas/items.json"',
    '',
    '  @case:RUN-API-002',
    '  Scenario: request headers and response variables',
    '    When I set header "X-Trace" to "{{run.namespace}}trace"',
    '    And I send a GET request to "/api/items"',
    '    Then the response status should be 200',
    '    And I store the response field "$.items[0]" as "firstItem"',
    '    And the response header "x-echo-trace" should be "{{run.namespace}}trace"',
    '    And the response body at "$.items[0]" should be "1"',
  ].join('\n');
  write(suiteRoot, 'features/api/items.feature', feature);
  write(
    suiteRoot,
    'schemas/items.json',
    JSON.stringify({
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', minItems: 2 } },
    }),
  );
  write(
    suiteRoot,
    'features/api/posts.feature',
    [
      '@module:posts @layer:db',
      'Feature: Posts DB',
      '',
      '  @case:RUN-DB-001',
      '  Scenario: create post',
      '    When I send a POST request to "/api/posts" with JSON:',
      '      """json',
      '      {"title": "{{run.namespace}}post"}',
      '      """',
      '    Then the response status should be 201',
      '    And the database table "posts" should have 1 row where "title" = "{{run.namespace}}post"',
    ].join('\n'),
  );
  write(suiteRoot, 'features/api/perf.feature', caseFeature(50));
  await runGit(['init', '-b', 'main'], { cwd: suiteRoot });
  await runGit(['add', '-A'], { cwd: suiteRoot });
  await runGit(['commit', '-m', 'chore: seed suite'], { cwd: suiteRoot });

  const environment = new EnvironmentRepository(database.db, tenant.id).create({
    projectId: project.id,
    name: 'staging',
    apiBaseUrl: api.baseUrl,
    webBaseUrl: api.baseUrl,
    healthcheckUrl: `${api.baseUrl}/healthz`,
    healthcheckExpectedStatus: 200,
    healthcheckTimeoutMs: 2_000,
    versionSource: options.versionSource ?? 'header',
    versionHeader: 'X-Deployed-Sha',
    deployedSha: headSha,
    strictVersionMatch: options.strictVersionMatch ?? true,
    envVarsJson: '{}',
    ...(options.withDatabase === false
      ? {}
      : {
          db: {
            type: 'sqlite' as const,
            name: sqlitePath,
            ssl: false,
            isTest: true,
            writeMode: 'fixtures' as const,
          },
        }),
    browserJson: '{}',
    caseTimeoutMs: 10_000,
    apiConcurrency: options.apiConcurrency ?? 4,
    uiConcurrency: 1,
    isDefault: true,
  });
  const runRepository = new RunRepository(database.db, tenant.id);
  let sequence = 0;

  return {
    dataDir,
    dbPath: sqlitePath,
    database,
    env,
    tenant,
    project,
    environment,
    headSha,
    apiBaseUrl: api.baseUrl,
    server: api.server,
    createRun(selection, key) {
      sequence += 1;

      return runRepository.create({
        projectId: project.id,
        environmentId: environment.id,
        baseSha: headSha,
        headSha,
        branch: 'main',
        selection,
        status: 'queued',
        idempotencyKey:
          key ??
          createHash('sha256')
            .update(`${JSON.stringify(selection)}:${sequence}`)
            .digest('hex'),
      });
    },
    async close() {
      await new Promise<void>((resolve) => api.server.close(() => resolve()));
      database.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(productDir, { recursive: true, force: true });
    },
  };
}
