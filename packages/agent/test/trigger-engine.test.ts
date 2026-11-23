// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvironmentRepository,
  GenerationRepository,
  JobQueue,
  ProjectRepository,
  RunRepository,
  TenantRepository,
  TriggerRepository,
} from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { TriggerEngine } from '../src/index.js';

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.cleanup();
  }
});

async function setup() {
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
  const environment = await new EnvironmentRepository(database.db, tenant.id).create({
    projectId: project.id,
    name: 'staging',
    apiBaseUrl: 'http://127.0.0.1:1',
    healthcheckExpectedStatus: 200,
    healthcheckTimeoutMs: 5_000,
    versionSource: 'manual',
    deployedSha: 'a'.repeat(40),
    strictVersionMatch: false,
    envVarsJson: '{}',
    browserJson: '{}',
    caseTimeoutMs: 30_000,
    apiConcurrency: 2,
    uiConcurrency: 1,
    isDefault: true,
  });
  const triggers = new TriggerRepository(database.db, tenant.id);
  const engine = new TriggerEngine({ db: database.db, now: () => 1_800_000_000_000 });

  return { database, tenant, project, environment, triggers, engine };
}

describe('trigger engine', () => {
  it('fires run triggers idempotently and enqueues run.execute', async () => {
    const { database, tenant, project, triggers, engine } = await setup();
    const trigger = await triggers.create({
      projectId: project.id,
      name: 'deploy',
      type: 'deployment',
      action: 'run',
      selection: { type: 'all', modules: [], caseKeys: [] },
    });
    const first = await engine.fire({
      trigger,
      project,
      headSha: 'b'.repeat(40),
      baseSha: 'a'.repeat(40),
    });
    const second = await engine.fire({
      trigger,
      project,
      headSha: 'b'.repeat(40),
      baseSha: 'a'.repeat(40),
    });

    expect(first.kind).toBe('run');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await new RunRepository(database.db, tenant.id).findById(first.id ?? '')).toBeDefined();
    expect((await new JobQueue(database.db).stats()).byStatus['queued']).toBe(1);
  });

  it('fires generation triggers with current/range modes', async () => {
    const { database, tenant, project, triggers, engine } = await setup();
    const trigger = await triggers.create({
      projectId: project.id,
      name: 'push',
      type: 'git_webhook',
      action: 'generate',
      selection: { type: 'modules', modules: ['posts'], caseKeys: [] },
    });
    const result = await engine.fire({
      trigger,
      project,
      headSha: 'c'.repeat(40),
      baseSha: 'b'.repeat(40),
    });
    const generation = await new GenerationRepository(database.db, tenant.id).findById(
      result.id ?? '',
    );

    expect(result.kind).toBe('generation');
    expect(generation?.mode).toBe('range');
    expect(generation?.trigger).toBe('webhook');
    expect(generation?.baseSha).toBe('b'.repeat(40));
  });

  it('rolls back the Run when enqueue fails inside the transaction', async () => {
    const { database, tenant, project, triggers } = await setup();
    const engine = new TriggerEngine({
      db: database.db,
      now: () => 1_800_000_000_000,
      queue: {
        async enqueueOn() {
          throw new Error('queue down');
        },
        async enqueue() {
          throw new Error('queue down');
        },
      } as unknown as JobQueue,
    });
    const trigger = await triggers.create({
      projectId: project.id,
      name: 'deploy',
      type: 'deployment',
      action: 'run',
      selection: { type: 'all', modules: [], caseKeys: [] },
    });

    await expect(
      engine.fire({
        trigger,
        project,
        headSha: 'b'.repeat(40),
        baseSha: 'a'.repeat(40),
      }),
    ).rejects.toThrow('queue down');

    // 入队失败时事务必须回滚：不能留下没有对应 job 的 Run。
    expect(
      await new RunRepository(database.db, tenant.id).listByProject(project.id, 10),
    ).toHaveLength(0);
  });

  it('skips run triggers when the environment has no deployed SHA', async () => {
    const { database, tenant, project, triggers, engine } = await setup();
    const environments = new EnvironmentRepository(database.db, tenant.id);
    const environment = (await environments.listByProject(project.id))[0];
    await environments.update(environment?.id ?? '', { deployedSha: null });
    const trigger = await triggers.create({
      projectId: project.id,
      name: 'schedule',
      type: 'schedule',
      action: 'run',
      cron: '*/5 * * * *',
      selection: { type: 'impact', modules: [], caseKeys: [] },
    });
    const result = await engine.fire({ trigger, project });

    expect(result.kind).toBe('skipped');
    expect(result.reason).toContain('deployed SHA');
  });

  it('computes schedule next run and falls back to impact=all without base SHA', async () => {
    const { database, tenant, project, triggers, engine } = await setup();
    const trigger = await triggers.create({
      projectId: project.id,
      name: 'schedule',
      type: 'schedule',
      action: 'run',
      cron: '0 9 * * *',
      selection: { type: 'impact', modules: [], caseKeys: [] },
    });
    const result = await engine.fire({ trigger, project });
    const run = await new RunRepository(database.db, tenant.id).findById(result.id ?? '');

    expect(result.kind).toBe('run');
    expect(run?.selectionJson).toContain('"type":"all"');
    expect(engine.nextRunAt('0 9 * * *', new Date('2026-11-21T10:00:00Z'))).toBe(
      Date.parse('2026-11-22T09:00:00Z'),
    );
  });
});
