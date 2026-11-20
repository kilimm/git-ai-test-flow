// 本文件所有改动要求遵循 agent-rules 规范
import { AppError, UrlSafetyChecker } from '@gait/config';
import type { DnsLookup, UrlSafetyChecker as UrlSafetyCheckerType } from '@gait/config';
import { RUN_ERROR_CODE, readVersionString } from '@gait/shared';
import type { VersionSource } from '@gait/shared';

export interface EnvironmentVerificationProfile {
  apiBaseUrl: string;
  healthcheckUrl?: string | null;
  healthcheckExpectedStatus?: number;
  healthcheckTimeoutMs?: number;
  versionSource: VersionSource;
  versionEndpoint?: string | null;
  versionJsonPath?: string | null;
  versionHeader?: string | null;
  deployedSha?: string | null;
  strictVersionMatch?: boolean;
}

export interface VerifyEnvironmentOptions {
  profile: EnvironmentVerificationProfile;
  targetHeadSha: string;
  urlSafety: UrlSafetyCheckerType;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  maxResponseBytes?: number;
}

export interface EnvironmentVerificationResult {
  ok: boolean;
  healthy: boolean;
  code: string | null;
  message: string;
  status: number | null;
  durationMs: number;
  deployedSha: string | null;
  versionMatch: boolean | null;
  healthcheckUrl: string | null;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MESSAGE_LENGTH = 300;

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AppError ? error.code : null;

  return `${code === null ? '' : `${code}: `}${message}`.slice(0, MAX_MESSAGE_LENGTH);
}

function joinUrl(baseUrl: string, relativePath: string): string {
  return new URL(relativePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done || value === undefined) {
      break;
    }

    const remaining = maxBytes - total;

    if (remaining <= 0) {
      await reader.cancel().catch(() => undefined);
      break;
    }

    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
}

async function fetchOnce(
  rawUrl: string,
  options: {
    urlSafety: UrlSafetyCheckerType;
    fetchImpl: typeof fetch;
    timeoutMs: number;
    signal?: AbortSignal;
    maxResponseBytes: number;
  },
): Promise<FetchResult> {
  await options.urlSafety.assertRequestTarget(rawUrl);
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await options.fetchImpl(rawUrl, {
    method: 'GET',
    redirect: 'manual',
    signal,
  });
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    status: response.status,
    headers,
    bodyText: await readLimitedText(response, options.maxResponseBytes),
    durationMs: Date.now() - startedAt,
  };
}

function normalizeSha(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();

  return /^[0-9a-f]{7,64}$/.test(trimmed) ? trimmed : trimmed.length > 0 ? trimmed : null;
}

/** 允许完整 SHA 与短 SHA 互相比对，但最少 7 位，避免过短误匹配。 */
export function versionsMatch(deployed: string | null, target: string | null): boolean {
  const left = normalizeSha(deployed);
  const right = normalizeSha(target);

  if (left === null || right === null) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  return shorter.length >= 7 && longer.startsWith(shorter);
}

/**
 * Run 启动前的环境校验：
 * 1. 健康检查失败立即终止（归因 env_issue）；
 * 2. 解析 deployedSha（manual/header/endpoint）；
 * 3. 与目标 headSha 比对，strictVersionMatch=true 时不一致阻断。
 */
export async function verifyEnvironment(
  options: VerifyEnvironmentOptions,
): Promise<EnvironmentVerificationResult> {
  const profile = options.profile;
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    profile.healthcheckTimeoutMs !== undefined && profile.healthcheckTimeoutMs > 0
      ? profile.healthcheckTimeoutMs
      : 60_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const expectedStatus = profile.healthcheckExpectedStatus ?? 200;
  const healthcheckUrl = profile.healthcheckUrl ?? null;
  const targetHeadSha = options.targetHeadSha;
  let status: number | null = null;

  try {
    options.urlSafety.assertHttpUrl(profile.apiBaseUrl);

    if (profile.versionEndpoint !== null && profile.versionEndpoint !== undefined) {
      options.urlSafety.assertHttpUrl(profile.versionEndpoint);
    }

    if (healthcheckUrl !== null) {
      const health = await fetchOnce(healthcheckUrl, {
        urlSafety: options.urlSafety,
        fetchImpl,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxResponseBytes,
      });

      status = health.status;

      if (health.status !== expectedStatus) {
        return {
          ok: false,
          healthy: false,
          code: RUN_ERROR_CODE.ENV_UNHEALTHY,
          message: `Healthcheck returned HTTP ${health.status}, expected ${expectedStatus}`,
          status,
          durationMs: Math.max(0, clock() - startedAt),
          deployedSha: normalizeSha(profile.deployedSha),
          versionMatch: null,
          healthcheckUrl,
        };
      }
    }

    let deployedSha: string | null = null;

    if (profile.versionSource === 'manual') {
      deployedSha = normalizeSha(profile.deployedSha);
    } else if (profile.versionSource === 'header') {
      const headerName = profile.versionHeader?.trim().toLowerCase();

      if (headerName === undefined || headerName.length === 0) {
        throw new Error('versionHeader is required when versionSource=header');
      }

      const headerUrl = healthcheckUrl ?? profile.apiBaseUrl;
      const response = await fetchOnce(headerUrl, {
        urlSafety: options.urlSafety,
        fetchImpl,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxResponseBytes,
      });

      status = status ?? response.status;
      deployedSha = normalizeSha(response.headers[headerName]);
    } else {
      const endpoint = profile.versionEndpoint;

      if (endpoint === null || endpoint === undefined || endpoint.length === 0) {
        throw new Error('versionEndpoint is required when versionSource=endpoint');
      }

      const response = await fetchOnce(endpoint, {
        urlSafety: options.urlSafety,
        fetchImpl,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxResponseBytes,
      });

      status = status ?? response.status;

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Version endpoint returned HTTP ${response.status}`);
      }

      const parsed: unknown = JSON.parse(response.bodyText);
      const path = profile.versionJsonPath ?? '$.deployedSha';
      deployedSha = normalizeSha(readVersionString(parsed, path));
    }

    const versionMatch =
      deployedSha === null ? null : versionsMatch(deployedSha, normalizeSha(targetHeadSha));

    if (profile.strictVersionMatch === true && versionMatch !== true) {
      return {
        ok: false,
        healthy: true,
        code: RUN_ERROR_CODE.ENV_VERSION_MISMATCH,
        message:
          deployedSha === null
            ? 'Unable to resolve deployed version while strictVersionMatch=true'
            : `Deployed version ${deployedSha} does not match target ${targetHeadSha}`,
        status,
        durationMs: Math.max(0, clock() - startedAt),
        deployedSha,
        versionMatch,
        healthcheckUrl,
      };
    }

    return {
      ok: true,
      healthy: true,
      code: versionMatch === false ? RUN_ERROR_CODE.ENV_VERSION_MISMATCH : null,
      message:
        versionMatch === false
          ? `Deployed version ${deployedSha ?? 'unknown'} differs from target ${targetHeadSha}`
          : 'Environment is healthy',
      status,
      durationMs: Math.max(0, clock() - startedAt),
      deployedSha,
      versionMatch,
      healthcheckUrl,
    };
  } catch (error) {
    return {
      ok: false,
      healthy: false,
      code: error instanceof AppError ? error.code : RUN_ERROR_CODE.ENV_UNHEALTHY,
      message: safeMessage(error),
      status,
      durationMs: Math.max(0, clock() - startedAt),
      deployedSha: normalizeSha(profile.deployedSha),
      versionMatch: null,
      healthcheckUrl,
    };
  }
}

/** 供步骤执行器把相对路径拼到环境 API 地址。 */
export function environmentUrl(apiBaseUrl: string, path: string): string {
  return joinUrl(apiBaseUrl, path);
}

/** 便捷构造器：测试可传 allowlist 与 lookup。 */
export function createUrlSafety(options: {
  allowlist?: readonly string[];
  lookup?: DnsLookup;
}): UrlSafetyCheckerType {
  return new UrlSafetyChecker({
    allowlist: options.allowlist ?? [],
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
  });
}
