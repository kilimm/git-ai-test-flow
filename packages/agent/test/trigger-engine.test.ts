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

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

function setup() {
  const database = createTestDatabase();
  databases.push(database);
  const tenant = new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://example.com/demo.git',
    defaultBranch: 'main',
    suiteMode: 'managed',
    featureRoot: 'features/',
    docsRoot: 'docs/ai/',
  });
  const environment = new EnvironmentRepository(database.db, tenant.id).create({
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
  it('fires run triggers idempotently and enqueues run.execute', () => {
    const { database, tenant, project, triggers, engine } = setup();
    const trigger = triggers.create({
      projectId: project.id,
      name: 'deploy',
      type: 'deployment',
      action: 'run',
      selection: { type: 'all', modules: [], caseKeys: [] },
    });
    const first = engine.fire({
      trigger,
      project,
      headSha: 'b'.repeat(40),
      baseSha: 'a'.repeat(40),
    });
    const second = engine.fire({
      trigger,
      project,
      headSha: 'b'.repeat(40),
      baseSha: 'a'.repeat(40),
    });

    expect(first.kind).toBe('run');
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(new RunRepository(database.db, tenant.id).findById(first.id ?? '')).toBeDefined();
    expect(new JobQueue(database.db).stats().byStatus['queued']).toBe(1);
  });

  it('fires generation triggers with current/range modes', () => {
    const { database, tenant, project, triggers, engine } = setup();
    const trigger = triggers.create({
      projectId: project.id,
      name: 'push',
      type: 'git_webhook',
      action: 'generate',
      selection: { type: 'modules', modules: ['posts'], caseKeys: [] },
    });
    const result = engine.fire({
      trigger,
      project,
      headSha: 'c'.repeat(40),
      baseSha: 'b'.repeat(40),
    });
    const generation = new GenerationRepository(database.db, tenant.id).findById(result.id ?? '');

    expect(result.kind).toBe('generation');
    expect(generation?.mode).toBe('range');
    expect(generation?.trigger).toBe('webhook');
    expect(generation?.baseSha).toBe('b'.repeat(40));
  });

  it('skips run triggers when the environment has no deployed SHA', () => {
    const { database, tenant, project, triggers, engine } = setup();
    const environments = new EnvironmentRepository(database.db, tenant.id);
    const environment = environments.listByProject(project.id)[0];
    environments.update(environment?.id ?? '', { deployedSha: null });
    const trigger = triggers.create({
      projectId: project.id,
      name: 'schedule',
      type: 'schedule',
      action: 'run',
      cron: '*/5 * * * *',
      selection: { type: 'impact', modules: [], caseKeys: [] },
    });
    const result = engine.fire({ trigger, project });

    expect(result.kind).toBe('skipped');
    expect(result.reason).toContain('deployed SHA');
  });

  it('computes schedule next run and falls back to impact=all without base SHA', () => {
    const { database, tenant, project, triggers, engine } = setup();
    const trigger = triggers.create({
      projectId: project.id,
      name: 'schedule',
      type: 'schedule',
      action: 'run',
      cron: '0 9 * * *',
      selection: { type: 'impact', modules: [], caseKeys: [] },
    });
    const result = engine.fire({ trigger, project });
    const run = new RunRepository(database.db, tenant.id).findById(result.id ?? '');

    expect(result.kind).toBe('run');
    expect(run?.selectionJson).toContain('"type":"all"');
    expect(engine.nextRunAt('0 9 * * *', new Date('2026-11-21T10:00:00Z'))).toBe(
      Date.parse('2026-11-22T09:00:00Z'),
    );
  });
});
