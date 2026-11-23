// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { RunnerService } from '../runners/runner-service.js';
import { parseInput } from './parse.js';

const idSchema = z.string().min(1).max(64);
const runnerParamsSchema = z.object({ id: idSchema }).strict();
const registerRunnerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    capacity: z.number().int().min(1).max(64).optional(),
  })
  .strict();
const heartbeatSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export interface RunnerApiDependencies {
  guards: AuthGuards;
  runnerService: RunnerService;
}

export function registerRunnerRoutes(
  api: FastifyInstance,
  dependencies: RunnerApiDependencies,
): void {
  const { guards, runnerService } = dependencies;

  api.get('/runners', { preHandler: guards.requireAuth }, async (request) => {
    return { items: await runnerService.list(getAuthContext(request)) };
  });

  api.post('/runners', { preHandler: guards.requireAuth }, async (request, reply) => {
    const body = parseInput(registerRunnerSchema, request.body);

    reply.status(201);
    return await runnerService.register(getAuthContext(request), body);
  });

  api.delete('/runners/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const params = parseInput(runnerParamsSchema, request.params);

    await runnerService.remove(getAuthContext(request), params.id);
    reply.status(204).send();
  });
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;

  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** 外部 Runner 心跳不经过会话/CSRF，使用注册时一次性 token 认证。 */
export function registerRunnerHeartbeatRoute(
  app: FastifyInstance,
  dependencies: Pick<RunnerApiDependencies, 'runnerService'>,
): void {
  app.post('/runner-heartbeat', async (request) => {
    const body = parseInput(heartbeatSchema, request.body);

    return {
      runner: await dependencies.runnerService.heartbeat(bearerToken(request), body),
    };
  });
}
