// 本文件所有改动要求遵循 agent-rules 规范
import cookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger, loadEnv, NotFoundError, nowMs, toProblemDetails } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { AuditLogWriter, openDatabase, runMigrations } from '@gait/db';
import type { AppDatabase, OpenedDatabase } from '@gait/db';
import { registerApiRoutes } from './api/routes.js';
import { AuthService } from './auth/auth-service.js';
import { createAuthGuards } from './auth/guards.js';
import { createGitLsRemoteRunner } from './config/git-client.js';
import type { GitLsRemote } from './config/git-client.js';
import { createFetchHttpClient } from './config/http-client.js';
import type { HttpClient } from './config/http-client.js';
import { createSecretCipher } from './config/secrets.js';
import { UrlSafetyChecker } from './config/ssrf.js';
import type { DnsLookup } from './config/ssrf.js';
import { GenerationService } from './generations/generation-service.js';
import { getRequestPath, toHttpProblem } from './problem.js';
import { CredentialService } from './projects/credential-service.js';
import { EnvironmentService } from './projects/environment-service.js';
import { LlmProfileService } from './projects/llm-profile-service.js';
import { NotificationService } from './projects/notification-service.js';
import { ProjectService } from './projects/project-service.js';
import type { ConfigServiceDeps } from './projects/support.js';
import { RunService } from './runs/run-service.js';
import { REQUEST_ID_HEADER, REQUEST_ID_RESPONSE_HEADER, resolveRequestId } from './request-id.js';
import { MemberService } from './tenants/member-service.js';
import { TenantService } from './tenants/tenant-service.js';

export const HEALTH_PATH = '/healthz';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface BuildAppOptions {
  env?: AppEnv;
  logger?: ReturnType<typeof createLogger>;
  /** 测试可注入已迁移的临时库；未提供时按 DATABASE_PATH 打开并在关闭时释放。 */
  db?: AppDatabase;
  now?: () => number;
  /** 配置模块外部依赖，测试可注入确定性的 HTTP/DNS/Git 实现。 */
  httpClient?: HttpClient;
  dnsLookup?: DnsLookup;
  gitLsRemote?: GitLsRemote;
}

function openServerDatabase(env: AppEnv): OpenedDatabase {
  const database = openDatabase({ path: env.DATABASE_PATH });

  try {
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
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
    ownedDatabase = openServerDatabase(env);
    db = ownedDatabase.db;
  }

  const app = Fastify({
    // pino 10 与 Fastify 内置的 FastifyBaseLogger 类型存在结构差异，运行时完全兼容。
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER]),
    // 关闭 Fastify 对请求头 ID 的直接信任，统一经由 resolveRequestId 校验。
    requestIdHeader: false,
    logController: new SanitizedLogController({ requestIdLogLabel: 'requestId' }),
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    hook: 'onRequest',
  });

  app.decorateRequest('auth', undefined);

  if (ownedDatabase !== undefined) {
    const database = ownedDatabase;

    app.addHook('onClose', async () => {
      database.close();
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
  const guards = createAuthGuards({ authService, auditWriter });
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
    authService,
    guards,
    memberService: new MemberService(db, clockOptions),
    tenantService: new TenantService(db, clockOptions),
    projectService: new ProjectService(db, configDeps),
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
  });

  app.get(HEALTH_PATH, async () => ({
    status: 'ok',
    uptimeMs: Math.round(process.uptime() * 1000),
  }));

  return app;
}
