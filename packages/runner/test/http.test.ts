// 本文件所有改动要求遵循 agent-rules 规范
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UrlSafetyChecker } from '@gait/config';
import {
  AssertionError,
  HttpExecutor,
  HttpExecutionError,
  assertErrorCode,
  assertHeader,
  assertJsonPathEquals,
  assertJsonSchema,
  assertStatus,
} from '../src/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/api/echo') {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.writeHead(201, {
          'content-type': 'application/json',
          'x-test-header': 'ok',
        });
        response.end(JSON.stringify({ received: JSON.parse(body || '{}'), items: [1, 2] }));
      });
      return;
    }

    if (request.url === '/api/error') {
      response.writeHead(400, { 'content-type': 'application/problem+json' });
      response.end(JSON.stringify({ code: 'VALIDATION_ERROR', detail: 'bad input' }));
      return;
    }

    if (request.url === '/api/large') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(10_000));
      return;
    }

    if (request.url === '/api/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }, 1_000);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"code":"NOT_FOUND"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function executor(maxResponseBytes?: number): HttpExecutor {
  return new HttpExecutor({
    baseUrl,
    urlSafety: new UrlSafetyChecker({ allowlist: ['127.0.0.1'] }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
}

describe('http executor', () => {
  it('sends requests and supports status/header/jsonpath/schema assertions', async () => {
    const response = await executor().request({
      method: 'POST',
      path: '/api/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });

    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ received: { title: 'hello' } });
    expect(response.attempts).toBe(1);

    assertStatus(response, 201);
    assertHeader(response, 'X-Test-Header', 'ok');
    assertJsonPathEquals(response.json, '$.received.title', 'hello');
    assertJsonPathEquals(response.json, '$.items[1]', '2');
    assertJsonSchema(response.json, {
      type: 'object',
      required: ['received', 'items'],
      properties: { items: { type: 'array' } },
    });
  });

  it('asserts problem error codes and rejects bad schemas', async () => {
    const response = await executor().request({ method: 'GET', path: '/api/error' });

    expect(response.status).toBe(400);
    assertErrorCode(response, 'VALIDATION_ERROR');
    expect(() => assertStatus(response, 200)).toThrow(AssertionError);
    expect(() =>
      assertJsonSchema(response.json, { type: 'object', required: ['missing'] }),
    ).toThrow(AssertionError);
    expect(() => assertJsonSchema({}, { type: 'not-a-real-type' })).toThrow(AssertionError);
  });

  it('caps response bodies and flags truncation', async () => {
    const response = await executor(100).request({ method: 'GET', path: '/api/large' });

    expect(response.truncated).toBe(true);
    expect(response.bodyText.length).toBeLessThanOrEqual(100);
  });

  it('rejects cross-origin URLs and invalid headers', async () => {
    await expect(
      executor().request({ method: 'GET', path: 'https://example.com/steal' }),
    ).rejects.toMatchObject({ code: 'HTTP_ORIGIN_FORBIDDEN' });

    await expect(
      executor().request({
        method: 'GET',
        path: '/api/echo',
        headers: { 'x-test': 'ok\r\nInjected: 1' },
      }),
    ).rejects.toMatchObject({ code: 'HTTP_HEADER_INVALID' });
  });

  it('aborts in-flight requests', async () => {
    const controller = new AbortController();
    const request = executor().request({
      method: 'GET',
      path: '/api/slow',
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);

    await expect(request).rejects.toBeInstanceOf(HttpExecutionError);
  });
});
