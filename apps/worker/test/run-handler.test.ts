// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { RunRepository, TenantAuditLogRepository } from '@gait/db';
import type { Job } from '@gait/db';
import { AUDIT_ACTION } from '@gait/shared';
import { createRunJobHandler } from '../src/run-handler.js';
import { setupRunFixture } from '../../../packages/runner/test/run-fixtures.js';

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
