// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { UrlSafetyChecker } from '@gait/config';
import type { DnsLookup } from '@gait/config';
import { createUrlSafety, verifyEnvironment, versionsMatch } from '../src/index.js';

const PUBLIC_DNS: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const TARGET = 'a'.repeat(40);

function safety(
  allowlist: string[] = ['api.example.test', 'version.example.test'],
): UrlSafetyChecker {
  return new UrlSafetyChecker({ allowlist, lookup: PUBLIC_DNS });
}

function fakeFetch(
  handler: (url: string) => { status?: number; headers?: Record<string, string>; body?: string },
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const result = handler(url);

    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers: result.headers ?? {},
    });
  }) as typeof fetch;
}

describe('environment verification', () => {
  it('checks health and resolves version from a header', async () => {
    const result = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        healthcheckUrl: 'https://api.example.test/healthz',
        healthcheckExpectedStatus: 200,
        healthcheckTimeoutMs: 2_000,
        versionSource: 'header',
        versionHeader: 'X-Deployed-Sha',
        deployedSha: null,
        strictVersionMatch: true,
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: fakeFetch(() => ({
        status: 200,
        headers: { 'x-deployed-sha': TARGET },
      })),
    });

    expect(result.ok).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.deployedSha).toBe(TARGET);
    expect(result.versionMatch).toBe(true);
    expect(result.status).toBe(200);
  });

  it('warns on mismatch by default and blocks in strict mode', async () => {
    const loose = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        versionSource: 'manual',
        deployedSha: 'b'.repeat(40),
        strictVersionMatch: false,
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: fakeFetch(() => ({ status: 200 })),
    });

    expect(loose.ok).toBe(true);
    expect(loose.versionMatch).toBe(false);
    expect(loose.code).toBe('ENV_VERSION_MISMATCH');

    const strict = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        versionSource: 'manual',
        deployedSha: 'b'.repeat(40),
        strictVersionMatch: true,
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: fakeFetch(() => ({ status: 200 })),
    });

    expect(strict.ok).toBe(false);
    expect(strict.code).toBe('ENV_VERSION_MISMATCH');
  });

  it('resolves version from a version endpoint with restricted JSONPath', async () => {
    const result = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        versionSource: 'endpoint',
        versionEndpoint: 'https://version.example.test/version',
        versionJsonPath: '$.data.build.sha',
        strictVersionMatch: true,
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: fakeFetch(() => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { build: { sha: TARGET } } }),
      })),
    });

    expect(result.ok).toBe(true);
    expect(result.deployedSha).toBe(TARGET);
    expect(result.versionMatch).toBe(true);
  });

  it('fails immediately on unhealthy environment or network error', async () => {
    const unhealthy = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        healthcheckUrl: 'https://api.example.test/healthz',
        healthcheckExpectedStatus: 200,
        healthcheckTimeoutMs: 2_000,
        versionSource: 'manual',
        deployedSha: TARGET,
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: fakeFetch(() => ({ status: 503 })),
    });

    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.code).toBe('ENV_UNHEALTHY');

    const unreachable = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'https://api.example.test',
        healthcheckUrl: 'https://api.example.test/healthz',
        healthcheckTimeoutMs: 100,
        versionSource: 'manual',
      },
      targetHeadSha: TARGET,
      urlSafety: safety(),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });

    expect(unreachable.ok).toBe(false);
    expect(unreachable.healthy).toBe(false);
    expect(unreachable.code).toBe('ENV_UNHEALTHY');
  });

  it('blocks private targets through SSRF checks', async () => {
    const result = await verifyEnvironment({
      profile: {
        apiBaseUrl: 'http://127.0.0.1:1',
        versionSource: 'manual',
      },
      targetHeadSha: TARGET,
      urlSafety: safety([]),
      fetchImpl: fakeFetch(() => ({ status: 200 })),
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('SSRF_BLOCKED');
  });

  it('compares full and short SHAs safely', () => {
    expect(versionsMatch(TARGET, TARGET.slice(0, 8))).toBe(true);
    expect(versionsMatch(TARGET, 'b'.repeat(40))).toBe(false);
    expect(versionsMatch(null, TARGET)).toBe(false);
    expect(versionsMatch('abc', 'abcdefg')).toBe(false);
  });

  it('creates a reusable URL safety checker', async () => {
    const checker = createUrlSafety({ allowlist: ['internal.example.test'], lookup: PUBLIC_DNS });

    await expect(
      checker.assertRequestTarget('https://internal.example.test/api'),
    ).resolves.toBeInstanceOf(URL);
  });
});
