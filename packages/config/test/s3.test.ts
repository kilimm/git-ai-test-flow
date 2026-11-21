// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { S3Client, createS3ClientFromEnv } from '../src/s3.js';

describe('S3 client', () => {
  it('signs path-style PUT/GET requests and returns object bodies', async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);

      if (request.method === 'GET') {
        return new Response(Buffer.from('artifact'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }

      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'artifacts',
      region: 'us-east-1',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      pathStyle: true,
      now: () => new Date('2026-11-21T10:00:00Z'),
      fetchImpl,
    });

    await client.putObject('tenant/run/file.png', Buffer.from('png'), 'image/png');
    const object = await client.getObject('tenant/run/file.png');

    expect(requests[0]?.url).toBe('https://s3.example.com/artifacts/tenant/run/file.png');
    expect(requests[0]?.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
    expect(requests[0]?.headers.get('x-amz-date')).toBe('20261121T100000Z');
    expect(object?.body.toString()).toBe('artifact');
    expect(object?.contentType).toBe('image/png');
  });

  it('uses virtual-hosted style and handles missing objects', async () => {
    const urls: string[] = [];
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'artifacts',
      region: 'eu-west-1',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      pathStyle: false,
      fetchImpl: (async (input: string | URL | Request) => {
        urls.push(String(input));

        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });

    expect(await client.getObject('missing')).toBeNull();
    expect(urls[0]).toBe('https://artifacts.s3.example.com/missing');
  });

  it('returns null when required env values are absent', () => {
    expect(createS3ClientFromEnv({ S3_REGION: 'us-east-1', S3_PATH_STYLE: true })).toBeNull();
  });
});
