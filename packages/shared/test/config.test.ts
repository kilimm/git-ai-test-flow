// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  gitRefPolicyIssues,
  hasControlCharacters,
  isFeishuWebhookUrl,
  isSensitiveEnvVarName,
  normalizeProjectSlug,
  normalizeRepoDir,
  normalizeRepoPath,
  projectSlugPolicyIssues,
  repoRelativePathIssues,
} from '../src/index.js';

describe('project slug policy', () => {
  it('accepts normalized slugs and rejects invalid characters', () => {
    expect(projectSlugPolicyIssues('demo-project')).toEqual([]);
    expect(projectSlugPolicyIssues('a1')).toEqual([]);
    expect(normalizeProjectSlug('  Demo-Project ')).toBe('demo-project');
    expect(projectSlugPolicyIssues('Demo')).not.toEqual([]);
    expect(projectSlugPolicyIssues('-demo')).not.toEqual([]);
    expect(projectSlugPolicyIssues('demo_project')).not.toEqual([]);
    expect(projectSlugPolicyIssues('a')).not.toEqual([]);
    expect(projectSlugPolicyIssues('a'.repeat(41))).not.toEqual([]);
  });
});

describe('repository relative paths', () => {
  it('accepts safe paths and normalizes directories', () => {
    expect(repoRelativePathIssues('features')).toEqual([]);
    expect(repoRelativePathIssues('.ai-test/')).toEqual([]);
    expect(repoRelativePathIssues('docs/ai')).toEqual([]);
    expect(normalizeRepoPath('./features/')).toBe('features');
    expect(normalizeRepoDir('./docs/ai//')).toBe('docs/ai/');
    expect(normalizeRepoDir('')).toBe('');
  });

  it('rejects absolute paths, traversal, backslashes and control characters', () => {
    for (const value of [
      '/etc/passwd',
      'C:/secret',
      '../escape',
      'a/../b',
      'a//b',
      'a\\b',
      '',
      'a/./b',
    ]) {
      expect(repoRelativePathIssues(value), value).not.toEqual([]);
    }

    expect(hasControlCharacters(`a${String.fromCharCode(0)}b`)).toBe(true);
    expect(hasControlCharacters('plain/path')).toBe(false);
  });
});

describe('git ref policy', () => {
  it('accepts normal branches and rejects unsafe refs', () => {
    for (const value of ['main', 'release/v1.2.3', 'feature/user-login']) {
      expect(gitRefPolicyIssues(value), value).toEqual([]);
    }

    for (const value of [
      'bad branch',
      '.hidden',
      'branch.',
      'branch..name',
      'branch/',
      'branch.lock',
      'foo@{bar',
      'foo~1',
      'foo^',
      'foo:bar',
      'foo?',
      'foo*',
      'foo[bar',
      'foo\\bar',
      '@',
    ]) {
      expect(gitRefPolicyIssues(value), value).not.toEqual([]);
    }
  });
});

describe('feishu webhook allowlist', () => {
  it('only accepts HTTPS Feishu or Lark hosts', () => {
    expect(isFeishuWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/a')).toBe(true);
    expect(isFeishuWebhookUrl('https://open.larksuite.com/open-apis/bot/v2/hook/a')).toBe(true);
    expect(isFeishuWebhookUrl('https://feishu.cn/open-apis/bot/v2/hook/a')).toBe(true);
    expect(isFeishuWebhookUrl('http://open.feishu.cn/open-apis/bot/v2/hook/a')).toBe(false);
    expect(isFeishuWebhookUrl('https://evil-feishu.cn/open-apis/bot/v2/hook/a')).toBe(false);
    expect(isFeishuWebhookUrl('https://feishu.cn.evil.com/hook')).toBe(false);
    expect(isFeishuWebhookUrl('https://user:pass@open.feishu.cn/hook')).toBe(false);
    expect(isFeishuWebhookUrl('not-a-url')).toBe(false);
  });
});

describe('sensitive environment variable names', () => {
  it('detects common secret-like names', () => {
    for (const name of [
      'DB_PASSWORD',
      'apiToken',
      'API_KEY',
      'PRIVATE_KEY',
      'client_secret',
      'AWS_ACCESS_KEY',
      'credentialRef',
    ]) {
      expect(isSensitiveEnvVarName(name), name).toBe(true);
    }

    for (const name of ['BASE_URL', 'REGION', 'USERNAME']) {
      expect(isSensitiveEnvVarName(name), name).toBe(false);
    }
  });
});
