// 本文件所有改动要求遵循 agent-rules 规范
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSION } from '@gait/shared';
import type { AuthGuards } from '../auth/guards.js';
import { getAuthContext } from '../auth/guards.js';
import type { QuotaService } from '../quotas/quota-service.js';
import { parseInput } from './parse.js';

const updateQuotaSchema = z
  .object({
    maxRunsPerDay: z.number().int().min(1).max(100_000).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(500).optional(),
    maxLlmTokensPerMonth: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();

export interface QuotaApiDependencies {
  guards: AuthGuards;
  quotaService: QuotaService;
}

export function registerQuotaRoutes(
  api: FastifyInstance,
  dependencies: QuotaApiDependencies,
): void {
  const { guards, quotaService } = dependencies;
  const requireActiveTenantParam = async (request: FastifyRequest): Promise<void> => {
    const id = (request.params as { id?: unknown }).id;

    guards.requireActiveTenant(request, typeof id === 'string' ? id : '');
  };

  api.get(
    '/tenants/:id/quota',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_READ),
      ],
    },
    async (request) => await quotaService.get(getAuthContext(request)),
  );

  api.patch(
    '/tenants/:id/quota',
    {
      preHandler: [
        guards.requireAuth,
        requireActiveTenantParam,
        guards.requirePermission(PERMISSION.TENANT_UPDATE),
      ],
    },
    async (request) => {
      const body = parseInput(updateQuotaSchema, request.body);

      return await quotaService.update(getAuthContext(request), body);
    },
  );
}
