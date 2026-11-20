// 本文件所有改动要求遵循 agent-rules 规范
import type { OutgoingHttpHeader } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, ValidationError } from '@gait/config';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import { buildApp, HEALTH_PATH } from '../src/app.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createCsrfGuard,
  createCsrfToken,
  setCsrfCookie,
  verifyCsrfRequest,
} from '../src/csrf.js';
import { createGracefulShutdown } from '../src/shutdown.js';
import { createTestApp, createTestEnv, TEST_SESSION_SECRET } from './helpers.js';

const openApps: FastifyInstance[] = [];
const testDatabases: TestDatabase[] = [];

async function createApp(): Promise<FastifyInstance> {
  const context = await createTestApp();
  openApps.push(context.app);
  testDatabases.push(context.database);
  return context.app;
}

function readHeader(value: OutgoingHttpHeader | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === 'string' ? value : undefined;
}

afterEach(async () => {
  const apps = openApps.splice(0);

  await Promise.all(
    apps.map(async (app) => {
      await app.close();
    }),
  );

  for (const database of testDatabases.splice(0)) {
    database.cleanup();
  }
});

describe('server app', () => {
  it('serves the health check with a request id', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: HEALTH_PATH });
    const body = response.json() as { status: string; uptimeMs: number };

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeMs).toBe('number');
    expect(readHeader(response.headers['x-request-id'])).toBeTruthy();
  });

  it('propagates a well-formed incoming request id', async () => {
    const app = await createApp();
    const requestId = 'req_01hzx-abc.123';
    const response = await app.inject({
      method: 'GET',
      url: HEALTH_PATH,
      headers: { 'x-request-id': requestId },
    });

    expect(readHeader(response.headers['x-request-id'])).toBe(requestId);
  });

  it('replaces an unsafe incoming request id', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: HEALTH_PATH,
      headers: { 'x-request-id': 'bad id<script>' },
    });
    const responseRequestId = readHeader(response.headers['x-request-id']);

    expect(responseRequestId).not.toBe('bad id<script>');
    expect(responseRequestId).toMatch(/^[\w.:-]{1,128}$/);
  });

  it('returns RFC 7807 for unknown routes without echoing the query string', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/missing?token=top-secret',
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(readHeader(response.headers['x-request-id'])).toBeTruthy();
    expect(body['status']).toBe(404);
    expect(body['code']).toBe('NOT_FOUND');
    expect(body['instance']).toBe('/missing');
    expect(JSON.stringify(body)).not.toContain('top-secret');
  });

  it('logs request paths without query strings', async () => {
    const lines: string[] = [];
    const database = createTestDatabase();
    testDatabases.push(database);
    const app = await buildApp({
      env: createTestEnv(),
      db: database.db,
      logger: createLogger({
        level: 'info',
        name: 'test-server',
        destination: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      }),
    });
    openApps.push(app);

    await app.inject({ method: 'GET', url: '/missing?token=top-secret' });

    const output = lines.join('\n');
    expect(output).toContain('"path":"/missing"');
    expect(output).toContain('"statusCode":404');
    expect(output).not.toContain('top-secret');
  });

  it('maps AppError instances to RFC 7807', async () => {
    const app = await createApp();

    app.get('/__test/validation', async () => {
      throw new ValidationError('Invalid profile', [
        { path: 'name', message: 'Required', code: 'invalid_type' },
      ]);
    });

    const response = await app.inject({ method: 'GET', url: '/__test/validation' });
    const body = response.json() as {
      code: string;
      detail: string;
      errors: Array<{ path: string; message: string; code: string }>;
    };

    expect(response.statusCode).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.detail).toBe('Invalid profile');
    expect(body.errors).toEqual([{ path: 'name', message: 'Required', code: 'invalid_type' }]);
  });

  it('does not leak unknown error details', async () => {
    const app = await createApp();

    app.get('/__test/failure', async () => {
      throw new Error('database password=hunter2');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/failure' });
    const body = response.json() as { code: string; detail: string };

    expect(response.statusCode).toBe(500);
    expect(readHeader(response.headers['x-request-id'])).toBeTruthy();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.detail).toBe('An unexpected error occurred');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('maps Fastify schema validation errors to RFC 7807', async () => {
    const app = await createApp();

    app.get(
      '/__test/schema',
      {
        schema: {
          querystring: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
      async () => ({ ok: true }),
    );

    const response = await app.inject({ method: 'GET', url: '/__test/schema' });
    const body = response.json() as {
      code: string;
      errors: Array<{ path: string; message: string; code: string }>;
    };

    expect(response.statusCode).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.code).toBe('required');
    expect(body.errors[0]?.message).toContain('name');
  });

  it('issues a readable CSRF cookie that matches the response token', async () => {
    const app = await createApp();

    app.get('/__test/csrf', async (_request, reply) => {
      const token = createCsrfToken(TEST_SESSION_SECRET);
      setCsrfCookie(reply, token, false);
      return { token };
    });

    const response = await app.inject({ method: 'GET', url: '/__test/csrf' });
    const cookie = readHeader(response.headers['set-cookie']);
    const body = response.json() as { token: string };

    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('HttpOnly');
    expect(verifyCsrfRequest(TEST_SESSION_SECRET, body.token, body.token)).toBe(true);
  });

  it('blocks mutating requests without a valid CSRF token', async () => {
    const app = await createApp();

    app.post('/__test/guarded', { preHandler: createCsrfGuard(TEST_SESSION_SECRET) }, async () => ({
      ok: true,
    }));

    const denied = await app.inject({
      method: 'POST',
      url: '/__test/guarded',
      payload: {},
    });
    const deniedBody = denied.json() as { code: string };

    expect(denied.statusCode).toBe(403);
    expect(deniedBody.code).toBe('FORBIDDEN');

    const token = createCsrfToken(TEST_SESSION_SECRET);
    const allowed = await app.inject({
      method: 'POST',
      url: '/__test/guarded',
      payload: {},
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: token,
      },
    });

    expect(allowed.statusCode).toBe(200);
  });

  it('closes the server once across repeated shutdown signals', async () => {
    const app = await createApp();
    const closeSpy = vi.spyOn(app, 'close');
    const shutdown = createGracefulShutdown(app);

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(closeSpy).toHaveBeenCalledTimes(1);

    const index = openApps.indexOf(app);
    if (index !== -1) {
      openApps.splice(index, 1);
    }
  });
});
