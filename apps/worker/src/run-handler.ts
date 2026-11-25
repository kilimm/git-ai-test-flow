// 本文件所有改动要求遵循 agent-rules 规范
import { join } from 'node:path';
import { createEncryptionKey, SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  ArtifactRepository,
  AuditLogWriter,
  CredentialRepository,
  EnvironmentRepository,
  LlmProfileRepository,
  ProjectRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, Credential, Environment, Project } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  LLM_PURPOSE,
  RUN_ERROR_CODE,
  isTerminalRunStatus,
} from '@gait/shared';
import type { RunReport } from '@gait/shared';
import {
  analyzeRun,
  buildRunReport,
  createLlmClient,
  notifyRun,
  renderReportHtml,
  renderReportJUnit,
  renderReportMarkdown,
  runRunWorkflow,
} from '@gait/agent';
import type { LlmClient } from '@gait/agent';
import { ArtifactStore, RunExecutor, StepExecutionError } from '@gait/runner';
import type { RunStageResult, TestAccount } from '@gait/runner';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { mirrorRunArtifacts } from './artifact-mirror.js';
import type { JobHandler } from './job-handler.js';
import type { WorkerLogger } from './worker.js';

export interface RunHandlerOptions {
  db: AppDatabase;
  env: AppEnv;
  logger?: WorkerLogger;
  checkpointer?: BaseCheckpointSaver;
  now?: () => number;
  llmClientFactory?: (config: Parameters<typeof createLlmClient>[0]) => LlmClient;
  fetchImpl?: typeof fetch;
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

function parseParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stageFailure(code: string, error: unknown): RunStageResult {
  return { ok: false, code, message: safeError(error) };
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
  const llmClientFactory = options.llmClientFactory ?? createLlmClient;

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
    const run = await runRepository.findById(runId);

    if (run === undefined) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (isTerminalRunStatus(run.status)) {
      return;
    }

    const project = await new ProjectRepository(db, tenantId).findById(run.projectId);

    if (project === undefined) {
      throw new Error('Run project not found');
    }

    const environment =
      run.environmentId === null
        ? undefined
        : await new EnvironmentRepository(db, tenantId).findById(run.environmentId);
    const credentials = new CredentialRepository(db, tenantId);
    const gitAuth = await gitCredential(project, credentials, tenantId, decrypt);
    const testAccount = await testAccountCredential(environment, credentials, tenantId, decrypt);
    const dbPassword = await dbPasswordCredential(environment, credentials, tenantId, decrypt);
    // 将 vision LLM Profile 注入 Midscene 所需的环境变量，使 [agent] 视觉步骤可用。
    // Midscene 在创建 Agent 时读取 MIDSCENE_MODEL_* 环境变量；进程内读取，故在此设置。
    await applyVisionProfileEnv(
      db,
      tenantId,
      project.id,
      credentials,
      decrypt,
      options.logger,
      env.DATA_DIR,
    );
    const resolveLlm = async (
      purpose: string,
    ): Promise<{ client: LlmClient; model: string } | null> => {
      const profiles = (
        await new LlmProfileRepository(db, tenantId).listByProject(project.id)
      ).filter((profile) => profile.enabled && profile.purpose === purpose);
      const profile = profiles[0];

      if (profile === undefined) {
        return null;
      }

      let apiKey: string | undefined;

      if (profile.credentialId !== null) {
        const llmCredential = await credentials.findById(profile.credentialId);

        if (llmCredential === undefined || llmCredential.type !== CREDENTIAL_TYPE.LLM_API_KEY) {
          options.logger?.warn?.(
            { runId, profileId: profile.id, purpose },
            'LLM credential missing; falling back',
          );

          return null;
        }

        apiKey = decrypt(tenantId, llmCredential);
      }

      const params = parseParams(profile.paramsJson);
      const client = llmClientFactory({
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey,
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
        ...(typeof params.maxTokens === 'number' ? { maxTokens: params.maxTokens } : {}),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      });

      return { client, model: profile.model };
    };
    const resolveTriageLlm = (): Promise<{ client: LlmClient; model: string } | null> =>
      resolveLlm(LLM_PURPOSE.TRIAGE);
    // API-agent 用通用 LLM：优先 triage profile（同项目通用模型），无则 null（回退视觉）。
    const apiAgentLlm = await resolveLlm(LLM_PURPOSE.TRIAGE);
    const executor = await RunExecutor.create({
      db,
      env,
      tenantId,
      runId,
      gitAuth,
      testAccount,
      dbPassword,
      apiAgentLlm: apiAgentLlm?.client ?? null,
      signal: context.signal,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      now: clock,
    });

    let lastReport: RunReport | null = null;

    try {
      const result = await runRunWorkflow(
        {
          prepareWorkspace: () => executor.prepareWorkspace(),
          verifyEnvironment: () => executor.verifyEnvironment(),
          prepareTestData: () => executor.prepareTestData(),
          discoverCases: () => executor.discoverCases(),
          runCases: () => executor.runCases(),
          rerunFailedCases: () => executor.rerunFailedCases(),
          aggregate: () => executor.aggregate(),
          fail: (code, message) => executor.fail(code, message),
          analyzeRun: async (): Promise<RunStageResult> => {
            try {
              const triage = await resolveTriageLlm();
              await analyzeRun({
                db,
                tenantId,
                runId,
                dataDir: env.DATA_DIR,
                ...(triage === null ? {} : { llm: triage.client, llmModel: triage.model }),
                readSuiteFile: (relativePath) => executor.readSuiteFile(relativePath),
                now: clock,
              });

              return { ok: true, code: null, message: null };
            } catch (error) {
              options.logger?.warn?.({ runId, err: safeError(error) }, 'run analysis failed');
              return stageFailure(RUN_ERROR_CODE.ANALYSIS_FAILED, error);
            }
          },
          repairFailedCases: () => executor.repairFailedCases(),
          generateReport: async (): Promise<RunStageResult> => {
            try {
              const report = await buildRunReport({
                db,
                tenantId,
                runId,
                baseUrl: env.PUBLIC_BASE_URL,
                now: clock,
              });
              const store = new ArtifactStore({
                dataDir: env.DATA_DIR,
                tenantId,
                runId,
                repository: new ArtifactRepository(db, tenantId),
                now: clock,
              });

              await store.writeJson('report', 'run-report', report, { format: 'json' });
              await store.writeText(
                'report',
                'run-report',
                renderReportMarkdown(report),
                'text/markdown; charset=utf-8',
                { format: 'markdown' },
              );
              await store.writeText('report', 'run-report', renderReportHtml(report), 'text/html', {
                format: 'html',
              });
              await store.writeText(
                'report',
                'run-report',
                renderReportJUnit(report),
                'application/xml',
                {
                  format: 'junit',
                },
              );
              lastReport = report;

              return { ok: true, code: null, message: null };
            } catch (error) {
              options.logger?.warn?.({ runId, err: safeError(error) }, 'run report failed');
              return stageFailure(RUN_ERROR_CODE.REPORT_FAILED, error);
            }
          },
          notifyRun: async (): Promise<RunStageResult> => {
            try {
              await notifyRun({
                db,
                tenantId,
                runId,
                env,
                cipher,
                baseUrl: env.PUBLIC_BASE_URL,
                ...(lastReport === null ? {} : { report: lastReport }),
                ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
                now: clock,
                ...(options.logger === undefined ? {} : { logger: options.logger }),
              });

              return { ok: true, code: null, message: null };
            } catch (error) {
              options.logger?.warn?.({ runId, err: safeError(error) }, 'run notification failed');
              return stageFailure(RUN_ERROR_CODE.NOTIFICATION_FAILED, error);
            }
          },
        },
        { runId, threadId: `run:${runId}` },
        options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer },
      );
      const current = await runRepository.findById(runId);
      const outcomeStatus = current?.status ?? 'failed';

      try {
        await mirrorRunArtifacts({
          db,
          env,
          tenantId,
          runId,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        });
      } catch (error) {
        options.logger?.warn?.({ runId, err: safeError(error) }, 'artifact mirror failed');
      }

      if (result.outcome === 'failed') {
        await auditWriter.append({
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
        await auditWriter.append({
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
      if (
        context.signal.aborted ||
        (error instanceof StepExecutionError && error.code === RUN_ERROR_CODE.RUN_ABORTED)
      ) {
        // 租约丢失：保持 running，交给队列重试与 checkpoint 恢复。
        throw error;
      }

      const message = safeError(error);
      const current = await runRepository.findById(runId);

      if (current === undefined || !isTerminalRunStatus(current.status)) {
        await executor.fail('INTERNAL', message);
      }

      await auditWriter.append({
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

async function findCredential(
  repository: CredentialRepository,
  id: string | null,
  expectedType: string,
): Promise<Credential | undefined> {
  if (id === null) {
    return undefined;
  }

  const credential = await repository.findById(id);

  return credential !== undefined && credential.type === expectedType ? credential : undefined;
}

async function gitCredential(
  project: Project,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): Promise<{ username?: string; token: string } | null> {
  const credential = await findCredential(
    credentials,
    project.gitCredentialId,
    CREDENTIAL_TYPE.GIT_PAT,
  );

  if (credential === undefined) {
    return null;
  }

  return {
    ...(credential.username === null ? {} : { username: credential.username }),
    token: decrypt(tenantId, credential),
  };
}

async function testAccountCredential(
  environment: Environment | undefined,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): Promise<TestAccount | null> {
  const credential = await findCredential(
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

async function dbPasswordCredential(
  environment: Environment | undefined,
  credentials: CredentialRepository,
  tenantId: string,
  decrypt: (tenantId: string, credential: Credential) => string,
): Promise<string | null> {
  const credential = await findCredential(
    credentials,
    environment?.dbCredentialId ?? null,
    CREDENTIAL_TYPE.DB_PASSWORD,
  );

  return credential === undefined ? null : decrypt(tenantId, credential);
}

/**
 * 从项目的 vision LLM Profile 注入 Midscene 环境变量。
 * Midscene 在构造 Agent 时读取 MIDSCENE_MODEL_NAME/API_KEY/BASE_URL/FAMILY。
 * 若无 vision profile 或凭据缺失，不设置，[agent] 步骤会正常报 VISION_UNAVAILABLE。
 */
async function applyVisionProfileEnv(
  db: AppDatabase,
  tenantId: string,
  projectId: string,
  credentials: CredentialRepository,
  decrypt: (tenantId: string, credential: Credential) => string,
  logger: { warn?: (obj: Record<string, unknown>, msg: string) => void } | undefined,
  dataDir: string,
): Promise<void> {
  const profiles = (
    await new LlmProfileRepository(db, tenantId).listByProject(projectId)
  ).filter((profile) => profile.enabled && profile.purpose === LLM_PURPOSE.VISION);
  const profile = profiles[0];

  if (profile === undefined) {
    logger?.warn?.({ projectId }, 'no vision LLM profile; [agent] steps will be unavailable');
    return;
  }

  let apiKey: string | undefined;

  if (profile.credentialId !== null) {
    const llmCredential = await credentials.findById(profile.credentialId);

    if (llmCredential === undefined || llmCredential.type !== CREDENTIAL_TYPE.LLM_API_KEY) {
      logger?.warn?.({ profileId: profile.id }, 'vision LLM credential missing');
      return;
    }

    apiKey = decrypt(tenantId, llmCredential);
  }

  // Midscene 不接受 openai 作为 family；DeepSeek 用专门的 deepseek family（支持视觉）。
  // openai-compatible 的 provider 根据 base_url/model 推断：默认视为 deepseek。
  let family: string = profile.provider;

  if (profile.provider === 'openai-compatible') {
    family =
      /deepseek/i.test(profile.baseUrl) || /deepseek/i.test(profile.model) ? 'deepseek' : 'gpt-5';
  }

  process.env.MIDSCENE_MODEL_NAME = profile.model;
  process.env.MIDSCENE_MODEL_BASE_URL = profile.baseUrl;
  process.env.MIDSCENE_MODEL_FAMILY = family;
  process.env.MIDSCENE_USE_VL_MODEL = 'true';
  // 默认 20 轮规划常不够「上传图片 + 截图核对 + 断言」这类长步骤，容易误报 planning cycle limit；
  // 允许用环境变量覆盖（默认放宽到 40）。视觉文件选择器的允许目录也在这里兜底。
  process.env.MIDSCENE_REPLANNING_CYCLE_LIMIT = process.env.MIDSCENE_REPLANNING_CYCLE_LIMIT ?? '40';
  process.env.MIDSCENE_FILE_CHOOSER_DIR =
    process.env.MIDSCENE_FILE_CHOOSER_DIR ?? join(dataDir, 'fixtures');

  if (apiKey !== undefined && apiKey.length > 0) {
    process.env.MIDSCENE_MODEL_API_KEY = apiKey;
  }
}
