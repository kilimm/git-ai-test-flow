// 本文件所有改动要求遵循 agent-rules 规范
import { createHash, createHmac } from 'node:crypto';

export interface S3ClientConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export interface S3Object {
  body: Buffer;
  contentType: string | null;
}

function hashHex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * 最小 AWS SigV4 S3 客户端（PutObject/GetObject/DeleteObject）。
 * 供 Worker 归档产物与 Server 缺本地文件时回源；不引入 AWS SDK。
 */
export class S3Client {
  private readonly config: S3ClientConfig;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(config: S3ClientConfig) {
    this.config = config;
    this.now = config.now ?? (() => new Date());
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  urlFor(key: string): URL {
    const endpoint = new URL(this.config.endpoint);
    const encoded = encodePath(key);

    if (this.config.pathStyle) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${this.config.bucket}/${encoded}`;
    } else {
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encoded}`;
    }

    return endpoint;
  }

  private sign(input: {
    method: string;
    url: URL;
    payloadHash: string;
    contentType?: string | undefined;
  }): Record<string, string> {
    const now = this.now();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: input.url.host,
      'x-amz-content-sha256': input.payloadHash,
      'x-amz-date': amzDate,
      ...(input.contentType === undefined ? {} : { 'content-type': input.contentType }),
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders
      .map((key) => `${key}:${headers[key]?.trim()}\n`)
      .join('');
    const canonicalRequest = [
      input.method,
      encodePath(decodeURIComponent(input.url.pathname)),
      input.url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders.join(';'),
      input.payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hashHex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const url = this.urlFor(key);
    const payloadHash = hashHex(body);
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: this.sign({ method: 'PUT', url, payloadHash, contentType }),
      body: new Uint8Array(body),
    });

    if (!response.ok) {
      throw new Error(`S3 PutObject failed with HTTP ${response.status}`);
    }
  }

  async getObject(key: string): Promise<S3Object | null> {
    const url = this.urlFor(key);
    const payloadHash = hashHex('');
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.sign({ method: 'GET', url, payloadHash }),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`S3 GetObject failed with HTTP ${response.status}`);
    }

    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const url = this.urlFor(key);
    const payloadHash = hashHex('');
    const response = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: this.sign({ method: 'DELETE', url, payloadHash }),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 DeleteObject failed with HTTP ${response.status}`);
    }
  }
}

export function createS3ClientFromEnv(env: {
  S3_ENDPOINT?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_REGION: string;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_PATH_STYLE: boolean;
  fetchImpl?: typeof fetch;
}): S3Client | null {
  if (
    env.S3_ENDPOINT === undefined ||
    env.S3_BUCKET === undefined ||
    env.S3_ACCESS_KEY_ID === undefined ||
    env.S3_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }

  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    pathStyle: env.S3_PATH_STYLE,
    ...(env.fetchImpl === undefined ? {} : { fetchImpl: env.fetchImpl }),
  });
}
