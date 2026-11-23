// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@gait/config';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import {
  DocRepository,
  ProjectRepository,
  TenantAuditLogRepository,
  TenantRepository,
} from '@gait/db';
import type { Job, Project, Tenant } from '@gait/db';
import { AUDIT_ACTION } from '@gait/shared';
import { createDocJobHandler } from '../src/doc-handler.js';

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.cleanup();
  }
});

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function job(tenantId: string | null): Job {
  return {
    id: 'job-doc-1',
    tenantId,
    type: 'doc.sync',
    payloadJson: '{}',
    status: 'running',
    priority: 20,
    runAfter: Date.now(),
    attempts: 1,
    maxAttempts: 2,
    lockedBy: 'worker-test',
    leaseExpiresAt: Date.now() + 60_000,
    dedupeKey: 'doc:test',
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

interface Fixture {
  database: TestDatabase;
  tenant: Tenant;
  project: Project;
}

async function setup(): Promise<Fixture> {
  const database = await createTestDatabase();
  databases.push(database);
  const tenant = await new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = await new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://example.com/demo.git',
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });

  return { database, tenant, project };
}

function buildHandler(fixture: Fixture) {
  return createDocJobHandler({
    db: fixture.database.db,
    env: loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      PUBLIC_BASE_URL: 'https://platform.example',
      DATA_DIR: './data/doc-handler-test',
    }),
    logger,
    now: () => Date.UTC(2026, 10, 23),
  });
}

const signal = new AbortController().signal;

describe('worker doc handler', () => {
  it('rejects payload without projectId', async () => {
    const fixture = await setup();
    const handler = buildHandler(fixture);

    await expect(
      handler({ job: job(fixture.tenant.id), payload: {}, workerId: 'worker-test', signal }),
    ).rejects.toThrow(/projectId/);
  });

  it('rejects a job without tenantId', async () => {
    const fixture = await setup();
    const handler = buildHandler(fixture);

    await expect(
      handler({
        job: job(null),
        payload: { projectId: fixture.project.id },
        workerId: 'worker-test',
        signal,
      }),
    ).rejects.toThrow(/tenantId/);
  });

  it('rejects unknown projects without leaking other tenants', async () => {
    const fixture = await setup();
    const handler = buildHandler(fixture);

    await expect(
      handler({
        job: job(fixture.tenant.id),
        payload: { projectId: 'missing-project' },
        workerId: 'worker-test',
        signal,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('compresses stored entries and writes an audit record', async () => {
    const fixture = await setup();
    const repository = new DocRepository(fixture.database.db, fixture.tenant.id);

    await repository.upsertEntry({
      projectId: fixture.project.id,
      commitSha: 'a'.repeat(40),
      committedAt: Date.UTC(2026, 10, 20),
      author: 'dev',
      title: 'feat: add module',
      summaryMd: '新增模块',
      detailMd: '模块细节',
      files: ['src/module.ts'],
      modules: ['module'],
      tokenCount: 20,
    });
    const handler = buildHandler(fixture);

    await handler({
      job: job(fixture.tenant.id),
      payload: { projectId: fixture.project.id, mode: 'compress' },
      workerId: 'worker-test',
      signal,
    });

    const audits = await new TenantAuditLogRepository(fixture.database.db, fixture.tenant.id).list({
      limit: 20,
    });

    expect(audits.items.some((entry) => entry.action === AUDIT_ACTION.DOC_COMPRESS)).toBe(true);
  });
});
