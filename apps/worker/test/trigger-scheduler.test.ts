// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvironmentRepository,
  JobQueue,
  ProjectRepository,
  RunRepository,
  TenantRepository,
  TriggerGlobalRepository,
  TriggerRepository,
} from '@gait/db';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { TriggerScheduler } from '../src/trigger-scheduler.js';

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('trigger scheduler', () => {
  it('fires due schedules, advances nextRunAt and is idempotent on rerun', async () => {
    const database = createTestDatabase();
    databases.push(database);
    const now = Date.UTC(2026, 10, 21, 10, 0);
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
    new EnvironmentRepository(database.db, tenant.id).create({
      projectId: project.id,
      name: 'staging',
      apiBaseUrl: 'http://127.0.0.1:1',
      healthcheckExpectedStatus: 200,
      healthcheckTimeoutMs: 5_000,
      versionSource: 'manual',
      deployedSha: 'd'.repeat(40),
      strictVersionMatch: false,
      envVarsJson: '{}',
      browserJson: '{}',
      caseTimeoutMs: 30_000,
      apiConcurrency: 2,
      uiConcurrency: 1,
      isDefault: true,
    });
    const trigger = new TriggerRepository(database.db, tenant.id).create({
      projectId: project.id,
      name: 'hourly',
      type: 'schedule',
      action: 'run',
      cron: '0 * * * *',
      nextRunAt: now - 60_000,
      selection: { type: 'all', modules: [], caseKeys: [] },
      now,
    });
    const scheduler = new TriggerScheduler({
      db: database.db,
      logger,
      now: () => now,
    });

    expect(await scheduler.runOnce()).toBe(1);
    const due = new TriggerGlobalRepository(database.db).listDue(now);

    expect(due).toHaveLength(0);
    expect(new RunRepository(database.db, tenant.id).listByProject(project.id)).toHaveLength(1);
    expect(new JobQueue(database.db).stats(now).byStatus['queued']).toBe(1);

    const stored = new TriggerRepository(database.db, tenant.id).findById(trigger.id);
    expect(stored?.nextRunAt).toBe(Date.UTC(2026, 10, 21, 11, 0));

    // 时间推进前再次执行不应重复创建 Run。
    expect(await scheduler.runOnce()).toBe(0);
  });
});
