// 本文件所有改动要求遵循 agent-rules 规范
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@gait/config';
import type { S3Client } from '@gait/config';
import { ArtifactRepository, ProjectRepository, RunRepository, TenantRepository } from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { mirrorRunArtifacts } from '../src/artifact-mirror.js';

const directories: string[] = [];
const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.cleanup();
  }

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('S3 artifact mirror', () => {
  it('uploads local artifacts and records the S3 key without changing files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gait-mirror-'));
    directories.push(dataDir);
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
    const run = await new RunRepository(database.db, tenant.id).create({
      projectId: project.id,
      headSha: 'a'.repeat(40),
      idempotencyKey: 'mirror-run',
    });
    const relative = `artifacts/${tenant.id}/${run.id}/failure.png`;
    const absolute = join(dataDir, relative);

    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, Buffer.from('png'));
    const artifact = await new ArtifactRepository(database.db, tenant.id).create({
      runId: run.id,
      type: 'screenshot',
      path: relative,
      mime: 'image/png',
      size: 3,
      sha256: 'hash',
      metadata: { label: 'failure' },
    });
    const uploads: Array<{ key: string; mime: string }> = [];
    const s3Client = {
      async putObject(key: string, _body: Buffer, mime: string) {
        uploads.push({ key, mime });
      },
    } as S3Client;
    const env = loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      PUBLIC_BASE_URL: 'http://localhost:3000',
      ARTIFACT_STORAGE: 's3',
    });
    const count = await mirrorRunArtifacts({
      db: database.db,
      env,
      tenantId: tenant.id,
      runId: run.id,
      s3Client,
    });
    const updated = await new ArtifactRepository(database.db, tenant.id).findById(artifact.id);

    expect(count).toBe(1);
    expect(uploads[0]?.key).toContain(`${tenant.id}/${run.id}/`);
    expect(uploads[0]?.mime).toBe('image/png');
    expect(updated?.storage).toBe('s3');
    expect(JSON.parse(updated?.metadataJson ?? '{}')).toMatchObject({
      label: 'failure',
    });
    expect(JSON.parse(updated?.metadataJson ?? '{}').s3Key).toContain(tenant.id);
  });
});
