// 本文件所有改动要求遵循 agent-rules 规范
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTimeoutError, createFetchHttpClient, joinUrl } from '../src/config/http-client.js';

describe('http client', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('slow');
        }, 200);

        return;
      }

      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/ok' });
        response.end();

        return;
      }

      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('abcdefghijklmnopqrstuvwxyz');

        return;
      }

      if (request.url === '/echo') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              method: request.method,
              body: Buffer.concat(chunks).toString('utf8'),
              header: request.headers['x-test-header'] ?? null,
            }),
          );
        });

        return;
      }

      response.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'Value' });
      response.end('{"ok":true}');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('Test HTTP server did not bind');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('performs GET/POST requests and normalizes response headers', async () => {
    const client = createFetchHttpClient();
    const response = await client({ method: 'GET', url: `${baseUrl}/ok`, timeoutMs: 2_000 });

    expect(response.status).toBe(200);
    expect(response.headers['x-custom']).toBe('Value');
    expect(JSON.parse(response.bodyText)).toEqual({ ok: true });

    const echoed = await client({
      method: 'POST',
      url: `${baseUrl}/echo`,
      headers: { 'content-type': 'application/json', 'x-test-header': 'abc' },
      body: '{"hello":"world"}',
      timeoutMs: 2_000,
    });
    expect(JSON.parse(echoed.bodyText)).toEqual({
      method: 'POST',
      body: '{"hello":"world"}',
      header: 'abc',
    });
  });

  it('does not follow redirects and truncates oversized bodies', async () => {
    const client = createFetchHttpClient();
    const redirect = await client({
      method: 'GET',
      url: `${baseUrl}/redirect`,
      timeoutMs: 2_000,
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/ok');

    const large = await client({
      method: 'GET',
      url: `${baseUrl}/large`,
      timeoutMs: 2_000,
      maxResponseBytes: 10,
    });
    expect(large.bodyText).toBe('abcdefghij');
  });

  it('raises a timeout error and surfaces connection failures', async () => {
    const client = createFetchHttpClient();

    await expect(
      client({ method: 'GET', url: `${baseUrl}/slow`, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(HttpTimeoutError);

    await expect(
      client({ method: 'GET', url: 'http://127.0.0.1:1/unreachable', timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('joins base URLs with relative paths', () => {
    expect(joinUrl('https://api.example.com/v1', 'models')).toBe(
      'https://api.example.com/v1/models',
    );
    expect(joinUrl('https://api.example.com/v1/', 'models')).toBe(
      'https://api.example.com/v1/models',
    );
  });
});
