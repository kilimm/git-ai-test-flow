// 本文件所有改动要求遵循 agent-rules 规范
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { AppError } from '@gait/config';

export type DnsLookupResult = { address: string; family: number };
export type DnsLookup = (hostname: string) => Promise<DnsLookupResult[]>;

export class BlockedTargetError extends AppError {
  constructor(detail = 'Target address is not allowed') {
    super(detail, { status: 400, code: 'SSRF_BLOCKED', detail });
  }
}

export class DnsResolutionError extends Error {
  readonly code = 'DNS_FAILURE';

  constructor(hostname: string, options?: ErrorOptions) {
    super(`Unable to resolve host: ${hostname}`, options);
    this.name = 'DnsResolutionError';
  }
}

function buildAddressBlockList(): BlockList {
  const blockList = new BlockList();
  const ipv4Ranges: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  const ipv6Ranges: ReadonlyArray<readonly [string, number]> = [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
  ];

  for (const [network, prefix] of ipv4Ranges) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }

  for (const [network, prefix] of ipv6Ranges) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }

  return blockList;
}

const ADDRESS_BLOCK_LIST = buildAddressBlockList();

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Node 的 BlockList 在加入 IPv4-mapped 网段后会把所有 IPv4 查询误判为命中，
 * 因此这里手动把 `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx` 还原为 IPv4 再判断。
 */
function extractMappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();

  if (!lower.startsWith('::ffff:')) {
    return null;
  }

  const suffix = lower.slice('::ffff:'.length);

  if (isIP(suffix) === 4) {
    return suffix;
  }

  const groups = suffix.split(':');

  if (groups.length !== 2) {
    return null;
  }

  const high = Number.parseInt(groups[0] ?? '', 16);
  const low = Number.parseInt(groups[1] ?? '', 16);

  if (!Number.isInteger(high) || !Number.isInteger(low)) {
    return null;
  }

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** 私网、回环、链路本地与云元数据地址统一拒绝。 */
export function isBlockedAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.trim());
  const family = isIP(normalized);

  if (family === 4) {
    return ADDRESS_BLOCK_LIST.check(normalized, 'ipv4');
  }

  if (family === 6) {
    const mapped = extractMappedIpv4(normalized);

    if (mapped !== null) {
      return ADDRESS_BLOCK_LIST.check(mapped, 'ipv4');
    }

    return ADDRESS_BLOCK_LIST.check(normalized, 'ipv6');
  }

  return false;
}

function normalizeAllowlistEntry(entry: string): string {
  return entry.trim().toLowerCase().replace(/\.+$/, '');
}

export function isHostAllowlisted(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');

  return allowlist.some((rawEntry) => {
    const entry = normalizeAllowlistEntry(rawEntry);

    if (entry.length === 0) {
      return false;
    }

    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);

      return host.endsWith(suffix) && host !== suffix.slice(1);
    }

    return host === entry;
  });
}

export interface UrlSafetyOptions {
  allowlist: readonly string[];
  lookup?: DnsLookup;
}

export interface UrlSafetyCheckOptions {
  httpsOnly?: boolean;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];
const MAX_URL_LENGTH = 2_048;

/**
 * SSRF 守卫：
 * - 保存配置时做静态检查（协议、用户信息、私网字面量）；
 * - 实际发起请求前再做 DNS 解析检查，降低 DNS rebinding 风险；
 * - 只有显式加入允许列表的主机才可访问内网。
 */
export class UrlSafetyChecker {
  private readonly allowlist: readonly string[];
  private readonly lookup: DnsLookup;

  constructor(options: UrlSafetyOptions) {
    this.allowlist = options.allowlist;
    this.lookup =
      options.lookup ??
      (async (hostname) => {
        const rows = await dnsLookup(hostname, { all: true, verbatim: true });

        return rows.map((row) => ({ address: row.address, family: row.family }));
      });
  }

  assertHttpUrl(rawUrl: string, options: UrlSafetyCheckOptions = {}): URL {
    if (rawUrl.length > MAX_URL_LENGTH) {
      throw new BlockedTargetError('URL is too long');
    }

    let url: URL;

    try {
      url = new URL(rawUrl);
    } catch {
      throw new BlockedTargetError('URL is invalid');
    }

    const allowedProtocol = options.httpsOnly === true ? 'https:' : null;

    if (allowedProtocol !== null) {
      if (url.protocol !== allowedProtocol) {
        throw new BlockedTargetError('URL must use HTTPS');
      }
    } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedTargetError('URL must use HTTP or HTTPS');
    }

    if (url.username.length > 0 || url.password.length > 0) {
      throw new BlockedTargetError('URL must not contain embedded credentials');
    }

    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();

    if (hostname.length === 0) {
      throw new BlockedTargetError('URL must include a host');
    }

    if (isHostAllowlisted(hostname, this.allowlist)) {
      return url;
    }

    if (
      hostname === 'localhost' ||
      BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    ) {
      throw new BlockedTargetError('Local and internal hosts are not allowed');
    }

    if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
      throw new BlockedTargetError('Private or metadata addresses are not allowed');
    }

    return url;
  }

  /** 发起请求前的完整检查：静态规则 + DNS 解析结果。 */
  async assertRequestTarget(rawUrl: string, options: UrlSafetyCheckOptions = {}): Promise<URL> {
    const url = this.assertHttpUrl(rawUrl, options);
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();

    if (isHostAllowlisted(hostname, this.allowlist) || isIP(hostname) !== 0) {
      return url;
    }

    let addresses: DnsLookupResult[];

    try {
      addresses = await this.lookup(hostname);
    } catch (error) {
      throw new DnsResolutionError(hostname, { cause: error });
    }

    if (addresses.length === 0) {
      throw new DnsResolutionError(hostname);
    }

    if (addresses.some((row) => isBlockedAddress(row.address))) {
      throw new BlockedTargetError('Host resolves to a private or metadata address');
    }

    return url;
  }
}
