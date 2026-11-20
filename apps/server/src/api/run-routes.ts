// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance } from 'fastify';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import { parseInput } from './parse.js';
import type { RunService } from '../runs/run-service.js';
import {
  createRunSchema,
  notificationsQuerySchema,
  runArtifactParamsSchema,
  runParamsSchema,
  runReportQuerySchema,
} from './run-schemas.js';

export interface RunApiDependencies {
  guards: AuthGuards;
  runService: RunService;
}

export function registerRunRoutes(api: FastifyInstance, dependencies: RunApiDependencies): void {
  const { guards, runService } = dependencies;

  api.post(
    '/projects/:id/runs',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.RUN_CREATE)],
    },
    async (request, reply) => {
      const params = parseInput(runParamsSchema, request.params);
      const body = parseInput(createRunSchema, request.body);
      const result = runService.create(getAuthContext(request), params.id, body);

      reply.status(result.created ? 201 : 200);

      return { run: result.run, created: result.created };
    },
  );

  api.get(
    '/projects/:id/runs',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { items: runService.list(getAuthContext(request), params.id) };
    },
  );

  api.get(
    '/runs/:id',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { run: runService.get(getAuthContext(request), params.id) };
    },
  );

  api.post(
    '/runs/:id/cancel',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.RUN_CANCEL)],
    },
    async (request) => {
      const params = parseInput(runParamsSchema, request.params);

      return { run: runService.cancel(getAuthContext(request), params.id) };
    },
  );

  api.get(
    '/runs/:id/report',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request, reply) => {
      const params = parseInput(runParamsSchema, request.params);
      const query = parseInput(runReportQuerySchema, request.query);
      const report = runService.report(getAuthContext(request), params.id);
      const rendered = runService.renderReport(report, query.format);

      reply.header('content-type', rendered.contentType);

      if (query.download === '1') {
        reply.header(
          'content-disposition',
          `attachment; filename="run-${params.id}.${rendered.extension}"`,
        );
      }

      return rendered.body;
    },
  );

  api.get(
    '/runs/:id/artifacts/:artifactId',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request, reply) => {
      const params = parseInput(runArtifactParamsSchema, request.params);
      const artifact = runService.artifact(getAuthContext(request), params.id, params.artifactId);

      reply.header('content-type', artifact.mime);
      reply.header('content-disposition', `inline; filename="${artifact.filename}"`);
      reply.header('x-content-type-options', 'nosniff');

      return reply.send(artifact.body);
    },
  );

  api.get(
    '/notifications',
    {
      preHandler: [guards.requireAuth, guards.requirePermission(PERMISSION.PROJECT_READ)],
    },
    async (request) => {
      const query = parseInput(notificationsQuerySchema, request.query);

      return { items: runService.notifications(getAuthContext(request), query) };
    },
  );
}
