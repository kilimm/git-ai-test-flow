// 本文件所有改动要求遵循 agent-rules 规范
import { createEncryptionKey, SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  AuditLogWriter,
  CredentialRepository,
  EnvironmentRepository,
  ProjectRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, Credential, Environment, Project } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  isTerminalRunStatus,
} from '@gait/shared';
import { runRunWorkflow } from '@gait/agent';
import { RunExecutor } from '@gait/runner';
import type { TestAccount } from '@gait/runner';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { JobHandler } from './job-handler.js';
import type { WorkerLogger } from './worker.js';

export interface RunHandlerOptions {
  db: AppDatabase;
  env: AppEnv;
  logger?: WorkerLogger;
  checkpointer?: BaseCheckpointSaver;
  now?: () => number;
}

function payloadRunId(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { runId?: unknown }).runId !== 'string'
  ) {
    throw new Error('run.execute payload must contain runId');
  }

  return (payload as { runId: string }).runId;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})/g,
      '****',
    )
    .slice(0, 500);
}

/**
 * Worker 侧 Run 执行器：解密所需凭据后交给 RunExecutor + Graph B。
 * 凭据只存在于本次任务内存中；日志和审计不记录密钥。
 */
export function createRunJobHandler(options: RunHandlerOptions): JobHandler {
  const { db, env } = options;
  const clock = options.now ?? (() => Date.now());
  const cipher = new SecretCipher(
    createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION),
  );
  const auditWriter = new AuditLogWriter(db);

  function decrypt(tenantId: string, credential: Credential): string {
    return cipher.decrypt(tenantId, credential.id, credential.type, {
      ciphertext: credential.secretCiphertext,
      iv: credential.secretIv,
      authTag: credential.secretAuthTag,
      keyVersion: credential.keyVersion,
    });
  }

  return async (context) => {
    const runId = payloadRunId(context.payload);
    const tenantId = context.job.tenantId;

    if (tenantId === null) {
      throw new Error('run.execute job is missing tenantId');
    }

    const runRepository = new RunRepository(db, tenantId);
    const run = runRepository.findById(runId);

    if (run === undefined) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (isTerminalRunStatus(run.status)) {
      return;
    }

    const project = new ProjectRepository(db, tenantId).findById(run.projectId);

    if (project === undefined) {
      throw new Error('Run project not found');
    }

    const environment =
      run.environmentId === null
        ? undefined
        : new EnvironmentRepository(db, tenantId).findById(run.environmentId);
    const credentials = new CredentialRepository(db, tenantId);
    const gitAuth = gitCredential(project, credentials, tenantId, decrypt);
    const testAccount = testAccountCredential(environment, credentials, tenantId, decrypt);
    const dbPassword = dbPasswordCredential(environment, credentials, tenantId, decrypt);
    const executor = RunExecutor.create({
      db,
      env,
      tenantId,
      runId,
      gitAuth,
      testAccount,
      dbPassword,
      signal: context.signal,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      now: clock,
    });

    try {
      const result = await runRunWorkflow(
        executor,
        { runId, threadId: `run:${runId}` },
        options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer },
      );
      const current = runRepository.findById(runId);
      const outcomeStatus = current?.status ?? 'failed';

      if (result.outcome === 'failed') {
        auditWriter.append({
          tenantId,
          action: AUDIT_ACTION.RUN_FAIL,
          resourceType: AUDIT_RESOURCE_TYPE.RUN,
          resourceId: runId,
          detail: {
            code: result.failureCode,
            message: result.failureMessage?.slice(0, 300) ?? null,
            status: outcomeStatus,
          },
          now: clock(),
        });
      } else {
        auditWriter.append({
          tenantId,
          action: AUDIT_ACTION.RUN_FINISH,
          resourceType: AUDIT_RESOURCE_TYPE.RUN,
          resourceId: runId,
          detail: {
            status: outcomeStatus,
            headSha: current?.headSha ?? run.headSha,
            deployedSha: current?.deployedSha ?? null,
          },
          now: clock(),
        });
      }
    } catch (error) {
      if (context.signal.aborted) {
        // 租约丢失：保持 running，交给队列重试与 checkpoint 恢复。
        throw error;
      }

      const message = safeError(error);
      const current = runRepository.findById(runId);

      if (current === undefined || !isTerminalRunStatus(current.status)) {
        await executor.fail('INTERNAL', message);
      }

      auditWriter.append({
        tenantId,
        action: AUDIT_ACTION.RUN_FAIL,
        resourceType: AUDIT_RESOURCE_TYPE.RUN,
        resourceId: runId,
        detail: { code: 'INTERNAL', message },
        now: clock(),
      });

      throw error;
    } finally {
      await executor.close();
    }
  };
}

function findCredential(
  repository: CredentialRepository,
  id: string | null,
  expectedType: string,
): Credential | undefined {
  if (id === null) {
    return undefined;
  }

  const credential = repository.findById(id);

  return credential !== undefined && credential.type === expectedType ? credential : undefined;
}

function gitCredential(
  project: Project,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): { username?: string; token: string } | null {
  const credential = findCredential(credentials, project.gitCredentialId, CREDENTIAL_TYPE.GIT_PAT);

  if (credential === undefined) {
    return null;
  }

  return {
    ...(credential.username === null ? {} : { username: credential.username }),
    token: decrypt(tenantId, credential),
  };
}

function testAccountCredential(
  environment: Environment | undefined,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): TestAccount | null {
  const credential = findCredential(
    credentials,
    environment?.testAccountCredentialId ?? null,
    CREDENTIAL_TYPE.TEST_ACCOUNT,
  );

  if (credential === undefined) {
    return null;
  }

  return {
    username: credential.username ?? 'test',
    password: decrypt(tenantId, credential),
  };
}

function dbPasswordCredential(
  environment: Environment | undefined,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): string | null {
  const credential = findCredential(
    credentials,
    environment?.dbCredentialId ?? null,
    CREDENTIAL_TYPE.DB_PASSWORD,
  );

  return credential === undefined ? null : decrypt(tenantId, credential);
}
