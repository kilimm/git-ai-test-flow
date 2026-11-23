// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  buildModuleTree,
  flattenModuleTree,
  matchesModulePrefix,
  matchesModuleSelection,
  moduleAncestry,
  moduleLabel,
  normalizeModuleKey,
  normalizeModuleKeys,
} from '../src/module-tree.js';

describe('normalizeModuleKey', () => {
  it('slugifies a single segment deterministically', () => {
    expect(normalizeModuleKey('Posts')).toBe('posts');
    expect(normalizeModuleKey('/posts/')).toBe('posts');
    expect(normalizeModuleKey('userProfile')).toBe('user-profile');
    expect(normalizeModuleKey('billing_v2')).toBe('billing-v2');
  });

  it('preserves hierarchy across separators', () => {
    expect(normalizeModuleKey('posts.comments')).toBe('posts.comments');
    expect(normalizeModuleKey('Posts/Comments')).toBe('posts.comments');
    expect(normalizeModuleKey('Posts > Comments')).toBe('posts.comments');
    expect(normalizeModuleKey('posts::comments')).toBe('posts.comments');
  });

  it('rejects keys without ascii alphanumerics', () => {
    expect(normalizeModuleKey('   ')).toBeNull();
    expect(normalizeModuleKey('模块')).toBeNull();
  });

  it('normalizes arrays with dedupe', () => {
    expect(normalizeModuleKeys(['Posts', 'posts', 'posts.comments'])).toEqual([
      'posts',
      'posts.comments',
    ]);
  });
});

describe('modulePrefix', () => {
  it('matches parent to nested keys', () => {
    expect(matchesModulePrefix('posts.comments', 'posts')).toBe(true);
    expect(matchesModulePrefix('posts', 'posts')).toBe(true);
    expect(matchesModulePrefix('posts.comments', 'posts.comments')).toBe(true);
  });

  it('does not match child prefix against parent', () => {
    expect(matchesModulePrefix('posts', 'posts.comments')).toBe(false);
  });

  it('does not match by bare string prefix', () => {
    expect(matchesModulePrefix('posts-comments', 'posts')).toBe(false);
    expect(matchesModulePrefix('posts2', 'posts')).toBe(false);
  });

  it('supports selection of any module when empty', () => {
    expect(matchesModuleSelection(['posts'], [])).toBe(true);
    expect(matchesModuleSelection(['posts.comments'], ['auth'])).toBe(false);
    expect(matchesModuleSelection(['posts.comments'], ['posts'])).toBe(true);
    expect(matchesModuleSelection(['posts'], ['posts.comments'])).toBe(false);
  });
});

describe('moduleAncestry / moduleLabel', () => {
  it('builds ancestor chains', () => {
    expect(moduleAncestry('a.b.c')).toEqual(['a', 'a.b', 'a.b.c']);
  });

  it('builds human labels', () => {
    expect(moduleLabel('posts.user-profile')).toBe('Posts / User profile');
  });
});

describe('buildModuleTree', () => {
  it('creates parents and aggregates counts', () => {
    const tree = buildModuleTree([
      { key: 'posts', count: 2 },
      { key: 'posts.comments', count: 3 },
      { key: 'auth', count: 1 },
    ]);

    expect(tree.map((node) => node.key)).toEqual(['auth', 'posts']);
    const posts = tree.find((node) => node.key === 'posts');
    expect(posts?.direct).toBe(2);
    expect(posts?.featurePoints).toBe(5);
    expect(posts?.children.map((node) => node.key)).toEqual(['posts.comments']);
    expect(posts?.children[0]?.parent).toBe('posts');
  });

  it('auto-completes missing ancestors', () => {
    const tree = buildModuleTree([{ key: 'posts.comments.replies', count: 1 }]);
    const posts = tree[0];

    expect(posts?.key).toBe('posts');
    expect(posts?.direct).toBe(0);
    expect(posts?.featurePoints).toBe(1);
    expect(flattenModuleTree(tree).map((node) => node.key)).toEqual([
      'posts',
      'posts.comments',
      'posts.comments.replies',
    ]);
  });

  it('skips unnormalizable keys', () => {
    expect(buildModuleTree([{ key: '模块', count: 1 }])).toEqual([]);
  });
});
