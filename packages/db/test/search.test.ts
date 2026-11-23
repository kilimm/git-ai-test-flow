// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_TOKENS, escapeLikeToken, likePattern } from '../src/search.js';

describe('LIKE 搜索转义', () => {
  it('按字面量转义 %、_ 与反斜杠', () => {
    expect(escapeLikeToken('100%')).toBe('100\\%');
    expect(escapeLikeToken('a_b')).toBe('a\\_b');
    expect(escapeLikeToken('C:\\tmp')).toBe('C:\\\\tmp');
    expect(escapeLikeToken('plain-text')).toBe('plain-text');
  });

  it('结尾反斜杠被成对转义，不会产生悬空的 ESCAPE 字符', () => {
    // `%100\%` 会让 PostgreSQL 报 22025（invalid escape sequence）。
    expect(likePattern('100\\')).toBe('%100\\\\%');
  });

  it('限制检索词数量，避免超长查询拖垮数据库', () => {
    expect(MAX_SEARCH_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SEARCH_TOKENS)).toBe(true);
  });
});
