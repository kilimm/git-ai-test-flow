// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  BlockedTargetError,
  DnsResolutionError,
  UrlSafetyChecker,
  isBlockedAddress,
  isHostAllowlisted,
} from '../src/config/ssrf.js';

describe('ssrf address classification', () => {
  it('blocks loopback, private, link-local and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }

    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('matches allowlist entries exactly or via a wildcard subdomain', () => {
    expect(isHostAllowlisted('db.internal', ['db.internal'])).toBe(true);
    expect(isHostAllowlisted('api.db.internal', ['*.db.internal'])).toBe(true);
    expect(isHostAllowlisted('db.internal', ['*.db.internal'])).toBe(false);
    expect(isHostAllowlisted('evil-db.internal', ['db.internal'])).toBe(false);
    expect(isHostAllowlisted('db.internal.evil.com', ['db.internal'])).toBe(false);
  });
});

describe('UrlSafetyChecker', () => {
  it('validates protocol, credentials and literal private hosts', () => {
    const checker = new UrlSafetyChecker({ allowlist: [] });

    expect(checker.assertHttpUrl('https://example.com/api').hostname).toBe('example.com');
    expect(() => checker.assertHttpUrl('ftp://example.com')).toThrow(BlockedTargetError);
    expect(() => checker.assertHttpUrl('https://user:pass@example.com')).toThrow(
      BlockedTargetError,
    );
    expect(() => checker.assertHttpUrl('http://localhost:3000')).toThrow(BlockedTargetError);
    expect(() => checker.assertHttpUrl('http://metadata.google.internal')).toThrow(
      BlockedTargetError,
    );
    expect(() => checker.assertHttpUrl('http://127.0.0.1')).toThrow(BlockedTargetError);
    expect(() => checker.assertHttpUrl('http://[::1]')).toThrow(BlockedTargetError);
    expect(() => checker.assertHttpUrl('http://example.com', { httpsOnly: true })).toThrow(
      BlockedTargetError,
    );
  });

  it('allows explicitly allowlisted private hosts', () => {
    const checker = new UrlSafetyChecker({ allowlist: ['internal.test'] });

    expect(checker.assertHttpUrl('http://internal.test:8080/health').hostname).toBe(
      'internal.test',
    );
    expect(() => checker.assertHttpUrl('http://127.0.0.1', {})).toThrow(BlockedTargetError);
  });

  it('rejects DNS results that point at private addresses', async () => {
    const checker = new UrlSafetyChecker({
      allowlist: [],
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    });

    await expect(checker.assertRequestTarget('https://example.com')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });

  it('passes public DNS results and wraps resolution failures', async () => {
    const publicChecker = new UrlSafetyChecker({
      allowlist: [],
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(publicChecker.assertRequestTarget('https://example.com')).resolves.toBeInstanceOf(
      URL,
    );

    const failingChecker = new UrlSafetyChecker({
      allowlist: [],
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(failingChecker.assertRequestTarget('https://example.com')).rejects.toBeInstanceOf(
      DnsResolutionError,
    );
  });

  it('skips DNS checks for allowlisted hosts', async () => {
    let lookups = 0;
    const checker = new UrlSafetyChecker({
      allowlist: ['internal.test'],
      lookup: async () => {
        lookups += 1;

        return [{ address: '10.0.0.5', family: 4 }];
      },
    });

    await expect(checker.assertRequestTarget('https://internal.test')).resolves.toBeInstanceOf(URL);
    expect(lookups).toBe(0);
  });
});
