// 本文件所有改动要求遵循 agent-rules 规范
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  StepRegistry,
  buildFeatureIndex,
  parseFeatureSource,
  parseSuiteStepCatalog,
  resolveFromRecord,
  validateFeatureDrafts,
  validateVariableReferences,
} from '../src/index.js';
import type { FeatureDraft } from '@gait/shared';

function example(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../docs/examples/${name}`, import.meta.url)),
    'utf8',
  );
}

const EXAMPLES = {
  login: example('login.feature'),
  instagram: example('instagram-post.feature'),
  postApi: example('post-api.feature'),
};

function draft(path: string, content: string): FeatureDraft {
  return { path, content, action: 'create' };
}

function registry(): StepRegistry {
  return StepRegistry.createDefault();
}

describe('gherkin parsing', () => {
  it('parses all example features with tags, backgrounds and scenarios', () => {
    const login = parseFeatureSource(EXAMPLES.login);
    expect(login.errors).toEqual([]);
    expect(login.feature?.name).toBe('用户登录');
    expect(login.feature?.tags).toContain('module:auth');
    expect(login.feature?.backgroundSteps).toHaveLength(1);
    expect(login.feature?.scenarios).toHaveLength(2);
    expect(login.feature?.scenarios[0]?.steps.map((step) => step.keywordType)).toEqual([
      'Context',
      'Action',
      'Outcome',
    ]);

    const agent = parseFeatureSource(EXAMPLES.instagram);
    expect(agent.errors).toEqual([]);
    expect(agent.feature?.scenarios[0]?.steps[1]?.keywordType).toBe('Action');
    expect(agent.feature?.scenarios[0]?.steps[2]?.keywordType).toBe('Outcome');

    const api = parseFeatureSource(EXAMPLES.postApi);
    expect(api.errors).toEqual([]);
    expect(api.feature?.scenarios[0]?.steps[1]?.docString).toContain('fixture.post.title');
    expect(api.feature?.scenarios[1]?.steps[2]?.keywordType).toBe('Outcome');
  });

  it('reports syntax and empty-step errors with line numbers', () => {
    const emptyStep = parseFeatureSource('Feature: Broken\n  Scenario: x\n    Given\n');
    expect(emptyStep.feature).not.toBeNull();
    expect(emptyStep.errors[0]?.code).toBe('GHERKIN_STEP_MISSING');
    expect(emptyStep.errors[0]?.line).toBeGreaterThan(0);

    const syntax = parseFeatureSource(
      ['Feature: Broken', '  Scenario: x', '    Given something', '      """json', '      {'].join(
        '\n',
      ),
    );
    expect(syntax.feature).toBeNull();
    expect(syntax.errors[0]?.code).toBe('GHERKIN_SYNTAX_ERROR');
  });
});

describe('step registry and variables', () => {
  it('matches built-in and suite-provided patterns', () => {
    const custom = parseSuiteStepCatalog(
      JSON.stringify({
        steps: [{ name: 'custom-login', type: 'template', pattern: 'I login as {word}' }],
      }),
    );
    const stepRegistry = StepRegistry.createDefault(custom);

    expect(stepRegistry.match('I login as admin')).toMatchObject({
      type: 'template',
      params: ['admin'],
    });
    expect(stepRegistry.match('I send a POST request to "/api"')).toMatchObject({
      type: 'api',
      params: ['POST', '/api'],
    });
    expect(stepRegistry.match('[agent] 发布一条帖子')).toMatchObject({ type: 'agent' });
    expect(stepRegistry.match('some unknown step')).toBeUndefined();
  });

  it('rejects invalid suite step catalogs', () => {
    expect(() => parseSuiteStepCatalog('not-json')).toThrow();
    expect(() =>
      parseSuiteStepCatalog('{"steps":[{"name":"x","type":"bad","pattern":"x"}]}'),
    ).toThrow();
  });

  it('validates and interpolates variable references', () => {
    expect(validateVariableReferences('value {{fixture.post.title}}')).toEqual([]);
    expect(validateVariableReferences('value {{secret.apiToken}}')).toEqual([]);
    expect(validateVariableReferences('value {{unknown.x}}')).toHaveLength(1);
    expect(validateVariableReferences('value {{fixture.x')).toHaveLength(1);

    expect(
      resolveFromRecord('title={{fixture.post.title}} status={{fixture.post.status}}', {
        fixture: { post: { title: 'Hello', status: 201 } },
      }),
    ).toBe('title=Hello status=201');
    expect(resolveFromRecord('{{missing.value}}', {})).toBe('{{missing.value}}');
  });
});

describe('feature validation', () => {
  it('accepts all documented example features', () => {
    const result = validateFeatureDrafts({
      drafts: [
        draft('features/auth/login.feature', EXAMPLES.login),
        draft('features/posts/agent.feature', EXAMPLES.instagram),
        draft('features/posts/api.feature', EXAMPLES.postApi),
      ],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.scenarioCount).toBe(6);
    expect(result.stepProposals).toEqual([]);
    expect(result.files.every((file) => file.validationStatus === 'valid')).toBe(true);
  });

  it('rejects unknown steps, missing Then and forbidden tags', () => {
    const content = [
      '@module:auth @layer:ui',
      'Feature: Auth',
      '  @case:AUTH-X @skip',
      '  Scenario: Unknown',
      '    Given a totally unknown step',
    ].join('\n');
    const result = validateFeatureDrafts({
      drafts: [draft('features/auth/unknown.feature', content)],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['UNKNOWN_STEP', 'THEN_MISSING', 'FORBIDDEN_TAG']),
    );
    expect(result.stepProposals).toHaveLength(1);
    expect(result.stepProposals[0]?.text).toBe('a totally unknown step');
  });

  it('rejects agent actions without a following Then and missing required tags', () => {
    const content = [
      'Feature: Agent only',
      '  Scenario: No assertion',
      '    When [agent] 发布帖子',
    ].join('\n');
    const result = validateFeatureDrafts({
      drafts: [draft('features/posts/agent.feature', content)],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'MODULE_TAG_MISSING',
        'LAYER_TAG_MISSING',
        'CASE_TAG_MISSING',
        'THEN_MISSING',
      ]),
    );
  });

  it('detects secrets and invalid variables', () => {
    const content = [
      '@module:auth @layer:api',
      'Feature: Secrets',
      '  @case:AUTH-SECRET-001',
      '  Scenario: Leak',
      '    When I send a POST request to "/login" with JSON:',
      '      """json',
      '      {"password": "super-secret-value", "token": "{{unknown.token}}"}',
      '      """',
      '    Then the response status should be 200',
    ].join('\n');
    const result = validateFeatureDrafts({
      drafts: [draft('features/auth/secrets.feature', content)],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['SECRET_PASSWORD_ASSIGNMENT', 'VARIABLE_INVALID']),
    );
    expect(JSON.stringify(result.issues)).not.toContain('super-secret-value');
  });

  it('allows secrets supplied through variable placeholders', () => {
    const content = [
      '@module:auth @layer:api',
      'Feature: Variables',
      '  @case:AUTH-VAR-001',
      '  Scenario: Use placeholder',
      '    When I send a POST request to "/login" with JSON:',
      '      """json',
      '      {"password": "{{secret.testUser}}", "token": "{{fixture.token}}"}',
      '      """',
      '    Then the response status should be 200',
    ].join('\n');
    const result = validateFeatureDrafts({
      drafts: [draft('features/auth/variables.feature', content)],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.issues.filter((issue) => issue.code.startsWith('SECRET_'))).toEqual([]);
  });

  it('detects duplicate scenarios within drafts and against existing fingerprints', () => {
    const content = [
      '@module:posts @layer:api',
      'Feature: Posts',
      '  @case:POST-DUP-001',
      '  Scenario: Duplicate',
      '    When I send a GET request to "/api/posts"',
      '    Then the response status should be 200',
      '  @case:POST-DUP-001',
      '  Scenario: Duplicate',
      '    When I send a GET request to "/api/posts"',
      '    Then the response status should be 200',
    ].join('\n');
    const first = validateFeatureDrafts({
      drafts: [draft('features/posts/dup.feature', content)],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(first.valid).toBe(false);
    expect(first.issues.filter((issue) => issue.code === 'DUPLICATE_SCENARIO')).toHaveLength(1);

    const second = validateFeatureDrafts({
      drafts: [
        draft('features/posts/dup2.feature', content.replace('POST-DUP-001', 'POST-DUP-002')),
      ],
      stepRegistry: registry(),
      featurePrefix: 'features',
      existingFingerprints: new Set(first.files[0]?.fingerprints ?? []),
    });
    expect(second.issues.some((issue) => issue.code === 'DUPLICATE_SCENARIO')).toBe(true);
  });

  it('rejects paths outside the feature root and invalid Gherkin', () => {
    const result = validateFeatureDrafts({
      drafts: [
        draft('src/escape.feature', EXAMPLES.login),
        draft(
          'features/broken.feature',
          [
            'Feature: Broken',
            '  Scenario: x',
            '    Given something',
            '      """json',
            '      {',
          ].join('\n'),
        ),
      ],
      stepRegistry: registry(),
      featurePrefix: 'features',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['DRAFT_PATH_OUTSIDE_ROOT', 'GHERKIN_SYNTAX_ERROR']),
    );
  });
});

describe('feature index', () => {
  it('extracts module keys, cases, fingerprints and searchable steps', () => {
    const files = buildFeatureIndex('project-1', 'suite', [
      {
        path: 'features/auth/login.feature',
        content: EXAMPLES.login,
        blobSha: 'abc',
      },
      {
        path: 'features/posts/api.feature',
        content: EXAMPLES.postApi,
        blobSha: 'def',
      },
      {
        path: 'features/broken.feature',
        content: 'Feature: Broken\n Scenario: x\n Given\n',
        blobSha: 'ghi',
      },
    ]);

    expect(files).toHaveLength(3);
    expect(files[0]?.moduleKey).toBe('auth');
    expect(files[0]?.scenarios.map((scenario) => scenario.caseKey)).toEqual([
      'AUTH-LOGIN-001',
      'AUTH-LOGIN-002',
    ]);
    expect(files[0]?.scenarios[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.scenarios[0]?.searchText).toContain('/dashboard');
    expect(files[1]?.moduleKey).toBe('posts');
    expect(files[1]?.scenarios).toHaveLength(2);
    expect(files[2]).toMatchObject({ parseStatus: 'invalid', scenarios: [] });
  });
});
