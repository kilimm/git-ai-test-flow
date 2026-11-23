// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { FeaturePoint } from '@gait/shared';
import {
  classifyCoverage,
  retrieveCasesForFeaturePoints,
  tokenize,
} from '../src/generation/cases.js';
import type { CaseIndexPort, ExistingCaseRecord } from '../src/generation/cases.js';

function featurePoint(overrides: Partial<FeaturePoint> = {}): FeaturePoint {
  return {
    id: 'FP-001',
    title: 'Create post API',
    description: 'POST /api/posts returns 201',
    kind: 'api',
    risk: 'high',
    affectedModules: ['posts'],
    sources: [{ path: 'src/api/posts.ts', hunk: '@@', reason: 'endpoint' }],
    docRefs: [],
    existingCoverage: [],
    suggestedLayer: ['api'],
    ...overrides,
  };
}

function record(overrides: Partial<ExistingCaseRecord> = {}): ExistingCaseRecord {
  return {
    id: 'case-1',
    caseKey: 'POST-001',
    name: 'Create post through API',
    featurePath: 'features/posts/create.feature',
    moduleKey: 'posts',
    tags: ['module:posts', 'case:POST-001'],
    fingerprint: 'a'.repeat(64),
    status: 'active',
    ...overrides,
  };
}

describe('coverage classification', () => {
  it('tokenizes English words and drops stop words', () => {
    expect([...tokenize('Create the post through API')].sort()).toEqual([
      'create',
      'post',
      'through',
    ]);
  });

  it('distinguishes covered, needs_update, new and obsolete', () => {
    const point = featurePoint();

    expect(classifyCoverage(record(), point)).toBe('covered');
    expect(classifyCoverage(record({ tags: ['source:src/api/posts.ts'] }), point)).toBe(
      'needs_update',
    );
    expect(
      classifyCoverage(record({ name: 'Unrelated behavior', moduleKey: 'posts', tags: [] }), point),
    ).toBe('needs_update');
    expect(classifyCoverage(record({ moduleKey: 'auth', name: 'Login flow' }), point)).toBe('new');
    expect(
      classifyCoverage(record({ status: 'obsolete', name: 'Old create post API' }), point),
    ).toBe('obsolete');
  });

  it('retrieves, deduplicates and marks obsolete cases', async () => {
    const active = record();
    const needsUpdate = record({
      id: 'case-2',
      caseKey: 'POST-002',
      name: 'Create post old behavior',
      tags: ['source:src/api/posts.ts'],
    });
    const obsolete = record({
      id: 'case-3',
      caseKey: 'POST-OLD',
      name: 'Removed post endpoint',
      moduleKey: 'posts',
      status: 'obsolete',
    });
    const unrelated = record({
      id: 'case-4',
      caseKey: 'AUTH-001',
      name: 'Login',
      moduleKey: 'auth',
    });
    const port: CaseIndexPort = {
      searchCases: async () => [active, needsUpdate, active],
      listObsoleteCases: async () => [obsolete, unrelated],
    };

    const result = await retrieveCasesForFeaturePoints('project-1', port, [featurePoint()]);

    expect(result.map((item) => item.caseKey).sort()).toEqual(['POST-001', 'POST-002', 'POST-OLD']);
    expect(result.find((item) => item.caseKey === 'POST-002')?.coverage).toBe('needs_update');
    expect(result.find((item) => item.caseKey === 'POST-OLD')?.coverage).toBe('obsolete');
  });
});
