// 本文件所有改动要求遵循 agent-rules 规范
import { ConflictError, NotFoundError, uuidv7 } from '@gait/config';
import type { AppEnv, SecretCipher } from '@gait/config';
import {
  CredentialRepository,
  JobQueue,
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, AuditLogWriter, Credential, Project, RepairAttempt } from '@gait/db';
import { SuiteRepository } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE, JOB_TYPE_RUN } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface RepairView {
  id: string;
  runCaseId: string;
  attemptNo: number;
  repairClass: string;
  rationale: string;
  patchDiff: string | null;
  guardStatus: string;
  reviewStatus: string;
  featurePath: string | null;
  appliedCommit: string | null;
  createdAt: string;
}

export interface RepairServiceOptions {
  db: AppDatabase;
  env: AppEnv;
  cipher: SecretCipher;
  auditWriter: AuditLogWriter;
  now?: () => number;
}

function view(attempt: RepairAttempt): RepairView {
  return {
    id: attempt.id,
    runCaseId: attempt.runCaseId,
    attemptNo: attempt.attemptNo,
    repairClass: attempt.repairClass,
    rationale: attempt.rationale,
    patchDiff: attempt.patchDiff,
    guardStatus: attempt.guardStatus,
    reviewStatus: attempt.reviewStatus,
    featurePath: attempt.featurePath,
    appliedCommit: attempt.appliedCommit,
    createdAt: new Date(attempt.createdAt).toISOString(),
  };
}

/**
 * 修复审批与回滚：高风险修复必须经具备 repair:approve 的用户批准。
 * 只写 Suite 的 feature 文件，不触碰产品代码；commit 后记录 appliedCommit。
 */
export class RepairService {
  private readonly db: AppDatabase;
  private readonly env: AppEnv;
  private readonly cipher: SecretCipher;
  private readonly auditWriter: AuditLogWriter;
  private readonly now: () => number;

  constructor(options: RepairServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.cipher = options.cipher;
    this.auditWriter = options.auditWriter;
    this.now = options.now ?? (() => Date.now());
  }

  private requireAttempt(
    context: AuthContext,
    runCaseId: string,
    repairId: string,
  ): {
    runCase: NonNullable<ReturnType<RunCaseRepository['findById']>>;
    run: NonNullable<ReturnType<RunRepository['findById']>>;
    project: Project;
    attempt: RepairAttempt;
  } {
    const runCase = new RunCaseRepository(this.db, context.tenant.id).findById(runCaseId);

    if (runCase === undefined) {
      throw new NotFoundError('Run case not found');
    }

    const run = new RunRepository(this.db, context.tenant.id).findById(runCase.runId);

    if (run === undefined) {
      throw new NotFoundError('Run not found');
    }

    const project = requireProject(
      new ProjectRepository(this.db, context.tenant.id),
      run.projectId,
    );
    const attempt = new RepairAttemptRepository(this.db, context.tenant.id).findById(repairId);

    if (attempt === undefined || attempt.runCaseId !== runCase.id) {
      throw new NotFoundError('Repair not found');
    }

    return { runCase, run, project, attempt };
  }

  private gitAuth(project: Project): GitAuth | null {
    if (project.gitCredentialId === null) {
      return null;
    }

    const credential: Credential | undefined = new CredentialRepository(
      this.db,
      project.tenantId,
    ).findById(project.gitCredentialId);

    if (credential === undefined || credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
      return null;
    }

    return {
      ...(credential.username === null ? {} : { username: credential.username }),
      token: this.cipher.decrypt(project.tenantId, credential.id, credential.type, {
        ciphertext: credential.secretCiphertext,
        iv: credential.secretIv,
        authTag: credential.secretAuthTag,
        keyVersion: credential.keyVersion,
      }),
    };
  }

  private async openSuite(project: Project, headSha: string): Promise<SuiteRepository> {
    return SuiteRepository.open({
      mode: project.suiteMode,
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      suiteRepoUrl: project.suiteRepoUrl,
      suitePath: project.suitePath,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir: this.env.DATA_DIR,
      headSha,
      auth: this.gitAuth(project),
    });
  }

  async approve(context: AuthContext, runCaseId: string, repairId: string): Promise<RepairView> {
    const { runCase, run, project, attempt } = this.requireAttempt(context, runCaseId, repairId);

    if (attempt.guardStatus === 'blocked') {
      throw new ConflictError('Blocked repairs cannot be approved');
    }

    if (attempt.patchedContent === null || attempt.featurePath === null) {
      throw new ConflictError('Repair does not contain an applicable patch');
    }

    if (attempt.reviewStatus === 'approved' && attempt.appliedCommit !== null) {
      return view(attempt);
    }

    const suite = await this.openSuite(project, run.headSha);

    try {
      const current = suite.readFile(attempt.featurePath);

      if (current !== attempt.originalContent) {
        throw new ConflictError('Feature content changed after the repair was proposed');
      }

      suite.stageFeatureFile(attempt.featurePath, attempt.patchedContent);
      const commit = await suite.writeAndCommit(
        [{ path: attempt.featurePath, content: attempt.patchedContent }],
        `test: approve repair ${attempt.id} for ${runCase.id}`,
      );
      const updated = new RepairAttemptRepository(this.db, context.tenant.id).update(attempt.id, {
        reviewStatus: 'approved',
        appliedCommit: commit.commitSha,
      });
      new RunCaseRepository(this.db, context.tenant.id).update(runCase.id, {
        repairStatus: 'applied',
      });

      // 审批后自动创建一个只跑受影响场景的验证 Run；失败不阻塞已提交的修复。
      let rerunRunId: string | null = null;

      try {
        const now = this.now();
        const rerun = new RunRepository(this.db, context.tenant.id).create({
          id: uuidv7(now),
          projectId: project.id,
          environmentId: run.environmentId,
          baseSha: run.headSha,
          headSha: run.headSha,
          branch: project.defaultBranch,
          trigger: 'repair',
          selection:
            runCase.caseKey === null
              ? { type: 'all', modules: [], caseKeys: [] }
              : { type: 'cases', modules: [], caseKeys: [runCase.caseKey] },
          idempotencyKey: `repair:${attempt.id}:${run.headSha}`,
          now,
        });

        rerunRunId = rerun.id;
        new JobQueue(this.db).enqueue({
          type: JOB_TYPE_RUN,
          payload: { runId: rerun.id },
          tenantId: context.tenant.id,
          priority: 20,
          dedupeKey: `run:${rerun.id}`,
          maxAttempts: 2,
          now,
        });
      } catch {
        // 验证 Run 入队失败保留在审计中，修复提交本身已成功。
      }

      this.audit(context, AUDIT_ACTION.REPAIR_APPROVE, runCase.id, {
        repairId: attempt.id,
        commitSha: commit.commitSha,
        changed: commit.changed,
        rerunRunId,
      });

      return view(updated ?? attempt);
    } finally {
      await suite.dispose();
    }
  }

  reject(context: AuthContext, runCaseId: string, repairId: string): RepairView {
    const { runCase, attempt } = this.requireAttempt(context, runCaseId, repairId);
    const updated = new RepairAttemptRepository(this.db, context.tenant.id).update(attempt.id, {
      reviewStatus: 'rejected',
    });

    new RunCaseRepository(this.db, context.tenant.id).update(runCase.id, {
      repairStatus: 'rejected',
    });
    this.audit(context, AUDIT_ACTION.REPAIR_REJECT, runCase.id, { repairId: attempt.id });

    return view(updated ?? attempt);
  }

  async rollback(context: AuthContext, runCaseId: string, repairId: string): Promise<RepairView> {
    const { runCase, run, project, attempt } = this.requireAttempt(context, runCaseId, repairId);

    if (attempt.featurePath === null) {
      throw new ConflictError('Repair has no feature path to roll back');
    }

    const suite = await this.openSuite(project, run.headSha);

    try {
      suite.stageFeatureFile(attempt.featurePath, attempt.originalContent);
      const commit = await suite.writeAndCommit(
        [{ path: attempt.featurePath, content: attempt.originalContent }],
        `test: rollback repair ${attempt.id} for ${runCase.id}`,
      );
      const updated = new RepairAttemptRepository(this.db, context.tenant.id).update(attempt.id, {
        reviewStatus: 'rejected',
        appliedCommit: null,
        verifiedAt: null,
      });
      new RunCaseRepository(this.db, context.tenant.id).update(runCase.id, {
        repairStatus: 'rolled_back',
      });
      this.audit(context, AUDIT_ACTION.REPAIR_ROLLBACK, runCase.id, {
        repairId: attempt.id,
        commitSha: commit.commitSha,
      });

      return view(updated ?? attempt);
    } finally {
      await suite.dispose();
    }
  }

  list(context: AuthContext, runCaseId: string): RepairView[] {
    if (new RunCaseRepository(this.db, context.tenant.id).findById(runCaseId) === undefined) {
      throw new NotFoundError('Run case not found');
    }

    return new RepairAttemptRepository(this.db, context.tenant.id)
      .listByRunCase(runCaseId)
      .map(view);
  }

  private audit(
    context: AuthContext,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    runCaseId: string,
    detail: Record<string, unknown>,
  ): void {
    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action,
      resourceType: AUDIT_RESOURCE_TYPE.REPAIR,
      resourceId: runCaseId,
      detail,
      now: this.now(),
    });
  }
}
