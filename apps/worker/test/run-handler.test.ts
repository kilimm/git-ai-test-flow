// 本文件所有改动要求遵循 agent-rules 规范
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactRepository,
  RunCaseRepository,
  RunRepository,
  TenantAuditLogRepository,
} from '@gait/db';
import type { Job } from '@gait/db';
import { runGit } from '@gait/git';
import { AUDIT_ACTION } from '@gait/shared';
import { createRunJobHandler } from '../src/run-handler.js';
import { setupRunFixture, write } from '../../../packages/runner/test/run-fixtures.js';

function job(fixture: Awaited<ReturnType<typeof setupRunFixture>>, runId: string): Job {
  return {
    id: 'job-run-1',
    tenantId: fixture.tenant.id,
    type: 'run.execute',
    payloadJson: JSON.stringify({ runId }),
    status: 'running',
    priority: 20,
    runAfter: Date.now(),
    attempts: 1,
    maxAttempts: 2,
    lockedBy: 'worker-test',
    leaseExpiresAt: Date.now() + 60_000,
    dedupeKey: `run:${runId}`,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('worker run handler', () => {
  it('executes a queued run and records an audit entry', async () => {
    const fixture = await setupRunFixture();

    try {
      const run = fixture.createRun({
        type: 'cases',
        modules: [],
        caseKeys: ['RUN-API-001'],
      });
      const handler = createRunJobHandler({
        db: fixture.database.db,
        env: fixture.env,
        now: () => Date.now(),
      });

      await handler({
        job: job(fixture, run.id),
        payload: { runId: run.id },
        workerId: 'worker-test',
        signal: new AbortController().signal,
      });

      const stored = new RunRepository(fixture.database.db, fixture.tenant.id).findById(run.id);

      expect(stored?.status).toBe('succeeded');
      const audits = new TenantAuditLogRepository(fixture.database.db, fixture.tenant.id).list({
        limit: 20,
      });

      expect(
        audits.items.some(
          (entry) => entry.action === AUDIT_ACTION.RUN_FINISH && entry.resourceId === run.id,
        ),
      ).toBe(true);
      const reportArtifacts = new ArtifactRepository(
        fixture.database.db,
        fixture.tenant.id,
      ).listByRun(run.id);

      expect(reportArtifacts.filter((artifact) => artifact.type === 'report')).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });

  it('runs the full graph for a failing case and generates a report', async () => {
    const fixture = await setupRunFixture();
    const suiteRoot = join(fixture.dataDir, 'suites', fixture.project.id);

    try {
      write(
        suiteRoot,
        'features/api/failing.feature',
        [
          '@module:worker @layer:api',
          'Feature: Worker failure',
          '',
          '  @case:WORKER-FAIL-001',
          '  Scenario: failing status',
          '    When I send a GET request to "/api/items"',
          '    Then the response status should be 500',
        ].join('\n'),
      );
      await runGit(['add', '-A'], { cwd: suiteRoot });
      await runGit(['commit', '-m', 'test: failing scenario'], { cwd: suiteRoot });
      const run = fixture.createRun({
        type: 'cases',
        modules: [],
        caseKeys: ['WORKER-FAIL-001'],
      });
      const handler = createRunJobHandler({
        db: fixture.database.db,
        env: fixture.env,
        now: () => Date.now(),
      });

      await handler({
        job: job(fixture, run.id),
        payload: { runId: run.id },
        workerId: 'worker-test',
        signal: new AbortController().signal,
      });

      const stored = new RunRepository(fixture.database.db, fixture.tenant.id).findById(run.id);
      const cases = new RunCaseRepository(fixture.database.db, fixture.tenant.id).listByRun(run.id);
      const reportArtifacts = new ArtifactRepository(
        fixture.database.db,
        fixture.tenant.id,
      ).listByRun(run.id);

      expect(stored?.status).toBe('failed');
      expect(cases[0]?.classification).toBe('unknown');
      expect(cases[0]?.attempt).toBe(2);
      expect(cases[0]?.evidenceJson).toContain('rerun');
      expect(reportArtifacts.filter((artifact) => artifact.type === 'report')).toHaveLength(4);
      expect(reportArtifacts.some((artifact) => artifact.mime.includes('markdown'))).toBe(true);
      expect(reportArtifacts.some((artifact) => artifact.mime.includes('xml'))).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('does nothing for a canceled run', async () => {
    const fixture = await setupRunFixture();

    try {
      const run = fixture.createRun({ type: 'all', modules: [], caseKeys: [] });
      const repository = new RunRepository(fixture.database.db, fixture.tenant.id);

      repository.update(run.id, { status: 'canceled', finishedAt: Date.now() });
      const handler = createRunJobHandler({ db: fixture.database.db, env: fixture.env });

      await handler({
        job: job(fixture, run.id),
        payload: { runId: run.id },
        workerId: 'worker-test',
        signal: new AbortController().signal,
      });

      expect(repository.findById(run.id)?.status).toBe('canceled');
      const audits = new TenantAuditLogRepository(fixture.database.db, fixture.tenant.id).list({
        limit: 20,
      });

      expect(audits.items.some((entry) => entry.resourceId === run.id)).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
