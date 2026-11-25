// 本文件所有改动要求遵循 agent-rules 规范
import cookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger, loadEnv, NotFoundError, nowMs, toProblemDetails } from '@gait/config';
import type { AppEnv } from '@gait/config';
import {
  AuditLogWriter,
  ScriptLibraryRepository,
  TenantRepository,
  openDatabase,
  runMigrations,
} from '@gait/db';
import { seedScriptLibrary } from '@gait/runner';
import type { AppDatabase, OpenedDatabase } from '@gait/db';
import { registerApiRoutes } from './api/routes.js';
import { AuthService } from './auth/auth-service.js';
import { CaseService } from './cases/case-service.js';
import { CaseMigrationService } from './cases/case-migration-service.js';
import { CaseAuthoringService } from './cases/case-authoring-service.js';
import { DocService } from './docs/doc-service.js';
import { createAuthGuards } from './auth/guards.js';
import { createGitLsRemoteRunner } from './config/git-client.js';
import type { GitLsRemote } from './config/git-client.js';
import { createFetchHttpClient } from './config/http-client.js';
import type { HttpClient } from './config/http-client.js';
import { createSecretCipher } from './config/secrets.js';
import { UrlSafetyChecker } from './config/ssrf.js';
import type { DnsLookup } from './config/ssrf.js';
import { CiService } from './integrations/ci-service.js';
import { GenerationService } from './generations/generation-service.js';
import { PromptTemplateService } from './prompts/prompt-template-service.js';
import { getRequestPath, toHttpProblem } from './problem.js';
import { OperationsService } from './operations.js';
import { CredentialService } from './projects/credential-service.js';
import { EnvironmentService } from './projects/environment-service.js';
import { LlmProfileService } from './projects/llm-profile-service.js';
import { NotificationService } from './projects/notification-service.js';
import { ProjectAccessService } from './projects/project-access-service.js';
import { ProjectService } from './projects/project-service.js';
import { QuotaService } from './quotas/quota-service.js';
import type { ConfigServiceDeps } from './projects/support.js';
import { RepairService } from './runs/repair-service.js';
import { RunService } from './runs/run-service.js';
import { registerPublicWebhookRoutes } from './api/trigger-routes.js';
import { registerRunnerHeartbeatRoute } from './api/runner-routes.js';
import { ScriptLibraryService } from './scripts/script-library-service.js';
import { SsoService } from './auth/sso-service.js';
import { RunnerService } from './runners/runner-service.js';
import { TriggerService } from './triggers/trigger-service.js';
import { REQUEST_ID_HEADER, REQUEST_ID_RESPONSE_HEADER, resolveRequestId } from './request-id.js';
import { registerSecurityHeaders } from './security.js';
import { MemberService } from './tenants/member-service.js';
import { TenantService } from './tenants/tenant-service.js';

export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface BuildAppOptions {
  env?: AppEnv;
  logger?: ReturnType<typeof createLogger>;
  /** 测试可注入已迁移的临时库；未提供时按 DATABASE_URL 打开并在关闭时释放。 */
  db?: AppDatabase;
  now?: () => number;
  /** 配置模块外部依赖，测试可注入确定性的 HTTP/DNS/Git 实现。 */
  httpClient?: HttpClient;
  dnsLookup?: DnsLookup;
  gitLsRemote?: GitLsRemote;
  /** 测试或反向代理环境可覆盖 API 限流参数。 */
  apiRateLimit?: { limit?: number; windowMs?: number };
}

async function openServerDatabase(
  env: AppEnv,
  logger: ReturnType<typeof createLogger>,
): Promise<OpenedDatabase> {
  const database = openDatabase({
    url: env.DATABASE_URL,
    onPoolError: (error) => logger.error({ err: error }, 'database pool error'),
  });

  try {
    await runMigrations(database);
    // 脚本库是 step 定义的唯一事实源：启动时补种内置 step（幂等，不覆盖租户改动）。
    await seedScriptLibraryForTenants(database.db, logger);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

/**
 * 对所有租户补种内置 step。
 * 失败只记日志、不阻断启动：脚本库为空时 runner 会回退到代码内置定义。
 */
async function seedScriptLibraryForTenants(
  db: AppDatabase,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const tenants = await new TenantRepository(db).listAll();

    for (const tenant of tenants) {
      const plan = await seedScriptLibrary(new ScriptLibraryRepository(db, tenant.id));

      if (plan.created > 0 || plan.updated > 0) {
        logger.info({ tenantId: tenant.id, ...plan }, 'script library seeded');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'script library seeding failed');
  }
}

/**
 * 默认请求日志会记录完整 URL（含查询串）。这里只记录路径，
 * 同时保留 Fastify 对完成日志与流错误日志的默认处理。
 */
class SanitizedLogController extends LogController {
  override incomingRequest(request: FastifyRequest, _reply: FastifyReply): void {
    if (this.isLogDisabled(request)) {
      return;
    }

    request.log.info(
      { method: request.method, path: getRequestPath(request.url) },
      'incoming request',
    );
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv();
  const logger = options.logger ?? createLogger({ level: env.LOG_LEVEL, name: 'gait-server' });
  let ownedDatabase: OpenedDatabase | undefined;
  let db = options.db;

  if (db === undefined) {
    ownedDatabase = await openServerDatabase(env, logger);
    db = ownedDatabase.db;
  }

  const app = Fastify({
    // pino 10 与 Fastify 内置的 FastifyBaseLogger 类型存在结构差异，运行时完全兼容。
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER]),
    // 关闭 Fastify 对请求头 ID 的直接信任，统一经由 resolveRequestId 校验。
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 60_000,
    logController: new SanitizedLogController({ requestIdLogLabel: 'requestId' }),
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    hook: 'onRequest',
  });

  registerSecurityHeaders(app, { production: env.NODE_ENV === 'production' });

  app.decorateRequest('auth', undefined);

  if (ownedDatabase !== undefined) {
    const database = ownedDatabase;

    app.addHook('onClose', async () => {
      await database.close();
    });
  }

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header(REQUEST_ID_RESPONSE_HEADER, request.id);
    return payload;
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(
      new NotFoundError('Route not found'),
      getRequestPath(request.url),
    );

    reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = toHttpProblem(error, getRequestPath(request.url));

    if (problem.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ status: problem.status, code: problem.code }, 'request rejected');
    }

    reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  // 错误处理器必须先于业务插件注册，子上下文才能继承统一的 RFC 7807 输出。
  const clockOptions = options.now === undefined ? {} : { now: options.now };
  const clock = options.now ?? (() => nowMs());
  const auditWriter = new AuditLogWriter(db);
  const authService = new AuthService(db, clockOptions);
  const projectAccessService = new ProjectAccessService(db);
  const quotaService = new QuotaService({
    db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const triggerService = new TriggerService({
    db,
    auditWriter,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runnerService = new RunnerService({
    db,
    auditWriter,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const guards = createAuthGuards({
    authService,
    auditWriter,
    projectAccess: projectAccessService,
  });
  const cipher = createSecretCipher(env);
  const configDeps: ConfigServiceDeps = {
    auditWriter,
    cipher,
    urlSafety: new UrlSafetyChecker({
      allowlist: env.SSRF_ALLOWLIST,
      ...(options.dnsLookup === undefined ? {} : { lookup: options.dnsLookup }),
    }),
    httpClient: options.httpClient ?? createFetchHttpClient(),
    gitLsRemote: options.gitLsRemote ?? createGitLsRemoteRunner(),
    now: clock,
  };

  await registerApiRoutes(app, {
    env,
    db,
    auditWriter,
    authService,
    guards,
    memberService: new MemberService(db, clockOptions),
    tenantService: new TenantService(db, clockOptions),
    projectService: new ProjectService(db, configDeps, projectAccessService),
    projectAccessService,
    credentialService: new CredentialService(db, configDeps),
    llmProfileService: new LlmProfileService(db, configDeps),
    environmentService: new EnvironmentService(db, configDeps),
    notificationService: new NotificationService(db, configDeps),
    generationService: new GenerationService({
      db,
      env,
      cipher,
      auditWriter,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    runService: new RunService({
      db,
      env,
      auditWriter,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    quotaService,
    scriptLibraryService: new ScriptLibraryService({
      db,
      auditWriter,
    }),
    promptTemplateService: new PromptTemplateService({
      db,
      auditWriter,
    }),
    repairService: new RepairService({
      db,
      env,
      cipher,
      auditWriter,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    docService: new DocService({
      db,
      env,
      cipher,
      auditWriter,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    triggerService,
    runnerService,
    ssoService: new SsoService({
      db,
      env,
      authService,
      cipher,
      deps: configDeps,
      auditWriter,
    }),
    ciService: new CiService({
      db,
      deps: configDeps,
      cipher,
      auditWriter,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    }),
    caseService: new CaseService(db),
    caseMigrationService: new CaseMigrationService(db, auditWriter, { DATA_DIR: env.DATA_DIR }),
    caseAuthoringService: new CaseAuthoringService({
      db,
      auditWriter,
      env: { DATA_DIR: env.DATA_DIR },
    }),
    operationsService: new OperationsService({
      db,
      workerStaleMs: Math.max(env.WORKER_LEASE_MS * 3, 60_000),
      now: clock,
    }),
    ...(options.apiRateLimit === undefined ? {} : { apiRateLimit: options.apiRateLimit }),
  });

  registerPublicWebhookRoutes(app, { triggerService });
  registerRunnerHeartbeatRoute(app, { runnerService });

  app.get(HEALTH_PATH, async () => ({
    status: 'ok',
    uptimeMs: Math.round(process.uptime() * 1000),
  }));

  app.get(READY_PATH, async (_request, reply) => {
    const readiness = await new OperationsService({
      db,
      workerStaleMs: Math.max(env.WORKER_LEASE_MS * 3, 60_000),
      now: clock,
    }).readiness();

    reply.status(readiness.status === 'ready' ? 200 : 503);

    return readiness;
  });

  return app;
}
