// 本文件所有改动要求遵循 agent-rules 规范

export type StepDefinitionType = 'builtin' | 'template' | 'script' | 'api' | 'db' | 'agent';

export interface StepDefinitionInput {
  name: string;
  type: StepDefinitionType;
  pattern: string;
  /** script/template 类型可指定 Suite 内相对路径；缺省按约定目录查找。 */
  script?: string;
  template?: string;
}

export interface StepMatch {
  definition: StepDefinitionInput;
  params: string[];
  type: StepDefinitionType;
}

interface CompiledDefinition {
  input: StepDefinitionInput;
  regex: RegExp;
  specificity: number;
}

const PLACEHOLDERS: Readonly<Record<string, string>> = {
  '{string}': '["\']([^"\']*)["\']',
  '{int}': '(\\d+)',
  '{word}': '([^\\s]+)',
  '{method}': '(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)',
  '{jsonPath}': '([^\\s]+)',
  '{anything}': '(.+)',
};

const BUILTIN_STEPS: readonly StepDefinitionInput[] = [
  { name: 'environment-ready', type: 'builtin', pattern: 'the test environment is ready' },
  { name: 'open-page', type: 'builtin', pattern: 'I am on the {string} page' },
  { name: 'enter-credentials', type: 'builtin', pattern: 'I enter my username and password' },
  {
    name: 'enter-explicit-credentials',
    type: 'builtin',
    pattern: 'I enter username {string} and password {string}',
  },
  {
    name: 'redirected-to',
    type: 'builtin',
    pattern: 'I should be redirected to the {string} page',
  },
  { name: 'stay-on-page', type: 'builtin', pattern: 'I should stay on the {string} page' },
  { name: 'see-error', type: 'builtin', pattern: 'I should see the error {string}' },
  { name: 'logged-in-as', type: 'template', pattern: 'I am logged in as {string}' },
  { name: 'test-database-prepared', type: 'db', pattern: 'the test database is prepared' },
  {
    name: 'send-json-request',
    type: 'api',
    pattern: 'I send a {method} request to {string} with JSON:',
  },
  { name: 'send-request', type: 'api', pattern: 'I send a {method} request to {string}' },
  { name: 'set-header', type: 'api', pattern: 'I set header {string} to {string}' },
  {
    name: 'store-response-field',
    type: 'api',
    pattern: 'I store the response field {jsonPath} as {string}',
  },
  { name: 'response-status', type: 'api', pattern: 'the response status should be {int}' },
  {
    name: 'response-time',
    type: 'api',
    pattern: 'the response time should be less than {int} milliseconds',
  },
  {
    name: 'response-json-schema',
    type: 'api',
    pattern: 'the response body should match JSON Schema {string}',
  },
  {
    name: 'response-jsonpath',
    type: 'api',
    pattern: 'the response body at {jsonPath} should be {string}',
  },
  {
    name: 'response-header',
    type: 'api',
    pattern: 'the response header {string} should be {string}',
  },
  {
    name: 'response-error-code',
    type: 'api',
    pattern: 'the response body should contain error code {string}',
  },
  { name: 'db-empty', type: 'db', pattern: 'the database table {string} is empty' },
  {
    name: 'db-row-count-where',
    type: 'db',
    pattern: 'the database table {string} should have {int} row where {string} = {string}',
  },
  {
    name: 'db-row-count-where-plural',
    type: 'db',
    pattern: 'the database table {string} should have {int} rows where {string} = {string}',
  },
  {
    name: 'db-row-count',
    type: 'db',
    pattern: 'the database table {string} should have {int} row',
  },
  {
    name: 'db-row-count-plural',
    type: 'db',
    pattern: 'the database table {string} should have {int} rows',
  },
  {
    name: 'db-query-row-count',
    type: 'db',
    pattern: 'the database query {string} should return {int} rows',
  },
  {
    name: 'db-query-contains',
    type: 'db',
    pattern: 'the database query {string} should contain {string}',
  },
  { name: 'ui-click', type: 'builtin', pattern: 'I click {string}' },
  { name: 'ui-fill', type: 'builtin', pattern: 'I fill {string} with {string}' },
  { name: 'ui-contains', type: 'builtin', pattern: 'the page should contain {string}' },
  {
    name: 'ui-visible',
    type: 'builtin',
    pattern: 'the element {string} should be visible',
  },
  { name: 'agent-step', type: 'agent', pattern: '[agent] {anything}' },
  { name: 'wait', type: 'builtin', pattern: 'I wait {int} milliseconds' },
];

/** 内置 step 名称 → 执行/持久化类型（UI 动作按 ui 记录）。 */
export const STEP_TYPE_BY_NAME: Readonly<Record<string, StepDefinitionType | 'ui'>> = Object.freeze(
  {
    'open-page': 'ui',
    'enter-credentials': 'ui',
    'enter-explicit-credentials': 'ui',
    'redirected-to': 'ui',
    'stay-on-page': 'ui',
    'see-error': 'ui',
    'ui-click': 'ui',
    'ui-fill': 'ui',
    'ui-contains': 'ui',
    'ui-visible': 'ui',
    'logged-in-as': 'template',
  },
);

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileStepPattern(pattern: string): RegExp {
  const parts = pattern.split(/(\{[A-Za-z]+\})/g);
  const source = parts.map((part) => PLACEHOLDERS[part] ?? escapeLiteral(part)).join('');

  return new RegExp(`^${source}$`);
}

function specificityOf(pattern: string): number {
  return pattern.replace(/\{[A-Za-z]+\}/g, '').length;
}

export class InvalidStepCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStepCatalogError';
  }
}

export interface SuiteStepCatalog {
  steps: StepDefinitionInput[];
}

/** 支持从 Suite 的 steps/registry.json 读取人工维护的模板/脚本 step。 */
export function parseSuiteStepCatalog(json: string | null): StepDefinitionInput[] {
  if (json === null || json.trim().length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new InvalidStepCatalogError(
      `steps/registry.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as SuiteStepCatalog).steps)
  ) {
    throw new InvalidStepCatalogError('steps/registry.json must be an object with a steps array');
  }

  return (parsed as SuiteStepCatalog).steps.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      typeof entry.pattern !== 'string' ||
      !['builtin', 'template', 'script', 'api', 'db', 'agent'].includes(entry.type)
    ) {
      throw new InvalidStepCatalogError(`steps/registry.json entry ${index} is invalid`);
    }

    const script = typeof entry.script === 'string' ? entry.script : undefined;
    const template = typeof entry.template === 'string' ? entry.template : undefined;

    return {
      name: entry.name,
      type: entry.type,
      pattern: entry.pattern,
      ...(script === undefined ? {} : { script }),
      ...(template === undefined ? {} : { template }),
    };
  });
}

/**
 * StepRegistry 先按字面量长度倒序匹配，再按定义顺序兜底；
 * 生成阶段只做干跑，不执行任何脚本。
 */
export class StepRegistry {
  private readonly definitions: CompiledDefinition[];

  constructor(definitions: readonly StepDefinitionInput[]) {
    this.definitions = definitions
      .map((input) => ({
        input,
        regex: compileStepPattern(input.pattern),
        specificity: specificityOf(input.pattern),
      }))
      .sort((left, right) => right.specificity - left.specificity);
  }

  static createDefault(custom: readonly StepDefinitionInput[] = []): StepRegistry {
    const seen = new Set<string>();
    const definitions: StepDefinitionInput[] = [];

    for (const definition of [...BUILTIN_STEPS, ...custom]) {
      const key = `${definition.type}:${definition.pattern}`;

      if (!seen.has(key)) {
        seen.add(key);
        definitions.push(definition);
      }
    }

    return new StepRegistry(definitions);
  }

  get stepPatterns(): readonly string[] {
    return this.definitions.map((definition) => definition.input.pattern);
  }

  match(text: string): StepMatch | undefined {
    const normalized = text.trim();

    for (const definition of this.definitions) {
      const match = definition.regex.exec(normalized);

      if (match !== null) {
        return {
          definition: definition.input,
          params: match.slice(1),
          type: definition.input.type,
        };
      }
    }

    return undefined;
  }
}
