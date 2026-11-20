// 本文件所有改动要求遵循 agent-rules 规范
import cookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger, loadEnv, NotFoundError, toProblemDetails } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { getRequestPath, toHttpProblem } from './problem.js';
import { REQUEST_ID_HEADER, REQUEST_ID_RESPONSE_HEADER, resolveRequestId } from './request-id.js';

export const HEALTH_PATH = '/healthz';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface BuildAppOptions {
  env?: AppEnv;
  logger?: ReturnType<typeof createLogger>;
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

  app.get(HEALTH_PATH, async () => ({
    status: 'ok',
    uptimeMs: Math.round(process.uptime() * 1000),
  }));

  return app;
}
