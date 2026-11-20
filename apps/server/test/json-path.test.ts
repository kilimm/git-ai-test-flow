// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  jsonPathIssues,
  parseJsonPath,
  readJsonPath,
  readVersionString,
} from '../src/config/json-path.js';

describe('json path subset', () => {
  it('parses rooted, bare and indexed paths', () => {
    expect(parseJsonPath('$').tokens).toEqual([]);
    expect(parseJsonPath('$.data.version').tokens).toEqual(['data', 'version']);
    expect(parseJsonPath('data.version').tokens).toEqual(['data', 'version']);
    expect(parseJsonPath('data.items[0].sha').tokens).toEqual(['data', 'items', 0, 'sha']);
  });

  it('rejects malformed paths', () => {
    for (const path of [
      '',
      '$.',
      '$data',
      'data..sha',
      'data[]',
      'data[abc]',
      'data[0',
      'data[0]x',
    ]) {
      expect(jsonPathIssues(path), path).not.toEqual([]);
    }
  });

  it('reads values and coerces version strings', () => {
    const value = { data: { deploy: { sha: 'abc123' }, list: [{ version: 42 }] } };
    expect(readJsonPath(value, '$.data.deploy.sha')).toBe('abc123');
    expect(readJsonPath(value, 'data.list[0].version')).toBe(42);
    expect(readJsonPath(value, 'data.missing')).toBeUndefined();
    expect(readJsonPath(value, 'data..bad')).toBeUndefined();
    expect(readJsonPath('scalar', 'data')).toBeUndefined();

    expect(readVersionString(value, '$.data.deploy.sha')).toBe('abc123');
    expect(readVersionString(value, 'data.list[0].version')).toBe('42');
    expect(readVersionString({ sha: '' }, 'sha')).toBeNull();
    expect(readVersionString({ sha: 'x'.repeat(256) }, 'sha')).toBeNull();
    expect(readVersionString({ sha: true }, 'sha')).toBeNull();
  });
});
