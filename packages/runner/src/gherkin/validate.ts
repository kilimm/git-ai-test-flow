// 本文件所有改动要求遵循 agent-rules 规范
import { GENERATION_LIMITS, TEST_LAYERS, repoRelativePathIssues } from '@gait/shared';
import type { FeatureDraft, StepProposal, ValidationIssue, ValidationResult } from '@gait/shared';
import { contentHash, scenarioFingerprint } from './fingerprint.js';
import { parseFeatureSource } from './parse.js';
import type { ParsedScenario, ParsedStep } from './parse.js';
import { validateVariableReferences } from '../steps/variables.js';
import type { StepRegistry } from '../steps/registry.js';

const FORBIDDEN_TAGS = new Set(['skip', 'only', 'wip']);
const MODULE_TAG = /^module:([A-Za-z0-9_-]+)$/;
const CASE_TAG = /^case:([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const LAYER_TAG = /^layer:(ui|api|db|e2e)$/;
const RISK_TAG = /^risk:(high|medium|low)$/;

const SECRET_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'GITHUB_TOKEN', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { code: 'OPENAI_KEY', pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { code: 'AWS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    code: 'PASSWORD_ASSIGNMENT',
    // 允许 `"password": "{{secret.password}}"` 这类显式变量引用。
    pattern:
      /["']?\b(password|passwd|secret|token|api[_-]?key)\b["']?\s*[:=]\s*["']?(?!\{\{)[^\s"']{6,}/i,
  },
  { code: 'BEARER_TOKEN', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { code: 'FEISHU_WEBHOOK', pattern: /open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{10,}/ },
];

export interface ValidatedDraft {
  path: string;
  content: string;
  contentHash: string;
  scenarioCount: number;
  fingerprints: string[];
  validationStatus: 'valid' | 'invalid';
  issues: ValidationIssue[];
}

export interface ValidateDraftsInput {
  drafts: readonly FeatureDraft[];
  stepRegistry: StepRegistry;
  existingFingerprints?: ReadonlySet<string>;
  featurePrefix?: string;
  maxSteps?: number;
}

export interface ValidateDraftsResult extends ValidationResult {
  files: ValidatedDraft[];
}

function tagValue(tags: readonly string[], pattern: RegExp): string | null {
  for (const tag of tags) {
    const match = pattern.exec(tag);

    if (match !== null) {
      return match[1] ?? null;
    }
  }

  return null;
}

function mergeTags(featureTags: readonly string[], scenarioTags: readonly string[]): string[] {
  return [...new Set([...featureTags, ...scenarioTags])];
}

function scanSecretIssues(
  path: string,
  line: number,
  scope: string,
  text: string,
  issues: ValidationIssue[],
): void {
  for (const { code, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        code: `SECRET_${code}`,
        severity: 'error',
        message: `Possible secret detected in ${scope}; redact it before committing`,
        path,
        line,
      });
    }
  }
}

function validateStep(
  path: string,
  scenario: ParsedScenario,
  step: ParsedStep,
  registry: StepRegistry,
  issues: ValidationIssue[],
  proposals: StepProposal[],
): void {
  for (const issue of validateVariableReferences(step.text)) {
    issues.push({
      code: 'VARIABLE_INVALID',
      severity: 'error',
      message: issue,
      path,
      line: step.line,
      scenario: scenario.name,
      step: step.text,
    });
  }

  scanSecretIssues(path, step.line, 'step text', step.text, issues);

  if (step.docString !== null) {
    for (const issue of validateVariableReferences(step.docString)) {
      issues.push({
        code: 'VARIABLE_INVALID',
        severity: 'error',
        message: issue,
        path,
        line: step.line,
        scenario: scenario.name,
        step: step.text,
      });
    }

    scanSecretIssues(path, step.line, 'doc string', step.docString, issues);
  }

  if (
    step.dataTable !== null &&
    step.dataTable.some((row) =>
      row.some((cell) => SECRET_PATTERNS.some((pattern) => pattern.pattern.test(cell))),
    )
  ) {
    issues.push({
      code: 'SECRET_TABLE',
      severity: 'error',
      message: 'Possible secret detected in data table; redact it before committing',
      path,
      line: step.line,
      scenario: scenario.name,
      step: step.text,
    });
  }

  if (registry.match(step.text) === undefined) {
    issues.push({
      code: 'UNKNOWN_STEP',
      severity: 'error',
      message: `Unknown step: ${step.text}`,
      path,
      line: step.line,
      scenario: scenario.name,
      step: step.text,
    });
    proposals.push({ keyword: step.keyword, text: step.text, path, line: step.line });
  }

  if (step.text.startsWith('[agent]')) {
    if (step.keywordType !== 'Action' && step.keywordType !== 'Outcome') {
      issues.push({
        code: 'AGENT_KEYWORD',
        severity: 'error',
        message: '[agent] steps must use When or Then',
        path,
        line: step.line,
        scenario: scenario.name,
        step: step.text,
      });
    }
  }
}

function validateScenario(
  path: string,
  featureTags: readonly string[],
  scenario: ParsedScenario,
  registry: StepRegistry,
  issues: ValidationIssue[],
  proposals: StepProposal[],
  maxSteps: number,
): string {
  const tags = mergeTags(featureTags, scenario.tags);
  const moduleKey = tagValue(tags, MODULE_TAG);
  const caseKey = tagValue(scenario.tags, CASE_TAG);
  const layer = tagValue(tags, LAYER_TAG);

  if (scenario.name.length === 0) {
    issues.push({
      code: 'SCENARIO_NAME_MISSING',
      severity: 'error',
      message: 'Scenario name must not be empty',
      path,
      line: scenario.line,
    });
  }

  if (moduleKey === null) {
    issues.push({
      code: 'MODULE_TAG_MISSING',
      severity: 'error',
      message: 'Scenario must have @module:<key> (on feature or scenario)',
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  if (layer === null) {
    issues.push({
      code: 'LAYER_TAG_MISSING',
      severity: 'error',
      message: 'Scenario must have @layer:ui|api|db|e2e',
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  if (caseKey === null) {
    issues.push({
      code: 'CASE_TAG_MISSING',
      severity: 'error',
      message: 'Scenario must have a stable @case:<id> tag',
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  for (const tag of tags) {
    const base = tag.split(':', 1)[0] ?? tag;

    if (FORBIDDEN_TAGS.has(base)) {
      issues.push({
        code: 'FORBIDDEN_TAG',
        severity: 'error',
        message: `Tag @${tag} is forbidden for generated or edited scenarios`,
        path,
        line: scenario.line,
        scenario: scenario.name,
      });
    }

    if (tag.startsWith('layer:') && !LAYER_TAG.test(tag)) {
      issues.push({
        code: 'LAYER_TAG_INVALID',
        severity: 'error',
        message: `Invalid layer tag @${tag}; expected @layer:${TEST_LAYERS.join('|')}`,
        path,
        line: scenario.line,
        scenario: scenario.name,
      });
    }

    if (tag.startsWith('risk:') && !RISK_TAG.test(tag)) {
      issues.push({
        code: 'RISK_TAG_INVALID',
        severity: 'warning',
        message: `Invalid risk tag @${tag}`,
        path,
        line: scenario.line,
        scenario: scenario.name,
      });
    }
  }

  for (const step of scenario.steps) {
    validateStep(path, scenario, step, registry, issues, proposals);
  }

  const outcomeIndexes = scenario.steps
    .map((step, index) => (step.keywordType === 'Outcome' ? index : -1))
    .filter((index) => index >= 0);

  if (outcomeIndexes.length === 0) {
    issues.push({
      code: 'THEN_MISSING',
      severity: 'error',
      message: 'Scenario must contain at least one Then assertion',
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  for (const [index, step] of scenario.steps.entries()) {
    if (
      step.text.startsWith('[agent]') &&
      step.keywordType === 'Action' &&
      !outcomeIndexes.some((outcomeIndex) => outcomeIndex > index)
    ) {
      issues.push({
        code: 'AGENT_THEN_MISSING',
        severity: 'error',
        message: 'A When [agent] step must be followed by a Then assertion',
        path,
        line: step.line,
        scenario: scenario.name,
        step: step.text,
      });
    }
  }

  if (scenario.steps.length > maxSteps) {
    issues.push({
      code: 'TOO_MANY_STEPS',
      severity: 'warning',
      message: `Scenario has ${scenario.steps.length} steps; consider splitting (>${maxSteps})`,
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  if (scenario.hasExamples) {
    issues.push({
      code: 'SCENARIO_OUTLINE_UNEXPANDED',
      severity: 'warning',
      message: 'Scenario Outline examples are not expanded during generation validation',
      path,
      line: scenario.line,
      scenario: scenario.name,
    });
  }

  return scenarioFingerprint({
    moduleKey: moduleKey ?? 'unknown',
    caseKey: caseKey ?? `AUTO-L${scenario.line}`,
    name: scenario.name,
    steps: scenario.steps,
  });
}

/** 生成/编辑草稿的统一校验入口；不合格草稿不得提交。 */
export function validateFeatureDrafts(input: ValidateDraftsInput): ValidateDraftsResult {
  const issues: ValidationIssue[] = [];
  const proposals: StepProposal[] = [];
  const files: ValidatedDraft[] = [];
  const maxSteps = input.maxSteps ?? GENERATION_LIMITS.MAX_STEPS_PER_SCENARIO;
  const existing = input.existingFingerprints ?? new Set<string>();
  const seenFingerprints = new Set<string>();
  const seenPaths = new Set<string>();
  let scenarioCount = 0;

  for (const draft of input.drafts) {
    const fileIssues: ValidationIssue[] = [];
    const pathIssues = repoRelativePathIssues(draft.path);

    if (pathIssues.length > 0) {
      fileIssues.push({
        code: 'DRAFT_PATH_INVALID',
        severity: 'error',
        message: pathIssues.join('; '),
        path: draft.path,
      });
    }

    if (!draft.path.endsWith('.feature')) {
      fileIssues.push({
        code: 'DRAFT_PATH_NOT_FEATURE',
        severity: 'error',
        message: 'Draft path must end with .feature',
        path: draft.path,
      });
    }

    if (input.featurePrefix !== undefined) {
      const prefix = input.featurePrefix.replace(/\/+$/, '');

      if (!draft.path.startsWith(`${prefix}/`)) {
        fileIssues.push({
          code: 'DRAFT_PATH_OUTSIDE_ROOT',
          severity: 'error',
          message: `Draft path must be under ${prefix}/`,
          path: draft.path,
        });
      }
    }

    if (seenPaths.has(draft.path)) {
      fileIssues.push({
        code: 'DUPLICATE_FILE_PATH',
        severity: 'error',
        message: 'Duplicated draft path',
        path: draft.path,
      });
    }

    seenPaths.add(draft.path);
    scanSecretIssues(draft.path, 1, 'feature file', draft.content, fileIssues);

    const parsed = parseFeatureSource(draft.content);
    fileIssues.push(...parsed.errors.map((error) => ({ ...error, path: draft.path })));

    const fingerprints: string[] = [];

    if (parsed.feature !== null) {
      for (const scenario of parsed.feature.scenarios) {
        const fingerprint = validateScenario(
          draft.path,
          parsed.feature.tags,
          scenario,
          input.stepRegistry,
          fileIssues,
          proposals,
          maxSteps,
        );
        fingerprints.push(fingerprint);
        scenarioCount += 1;

        if (existing.has(fingerprint)) {
          fileIssues.push({
            code: 'DUPLICATE_SCENARIO',
            severity: 'error',
            message: 'Scenario already exists with the same fingerprint',
            path: draft.path,
            line: scenario.line,
            scenario: scenario.name,
          });
        }

        if (seenFingerprints.has(fingerprint)) {
          fileIssues.push({
            code: 'DUPLICATE_SCENARIO',
            severity: 'error',
            message: 'Duplicated scenario within generated drafts',
            path: draft.path,
            line: scenario.line,
            scenario: scenario.name,
          });
        }

        seenFingerprints.add(fingerprint);
      }

      for (const step of parsed.feature.backgroundSteps) {
        validateVariableReferences(step.text).forEach((message) => {
          fileIssues.push({
            code: 'VARIABLE_INVALID',
            severity: 'error',
            message,
            path: draft.path,
            line: step.line,
          });
        });
        scanSecretIssues(draft.path, step.line, 'background step', step.text, fileIssues);

        if (input.stepRegistry.match(step.text) === undefined) {
          fileIssues.push({
            code: 'UNKNOWN_STEP',
            severity: 'error',
            message: `Unknown background step: ${step.text}`,
            path: draft.path,
            line: step.line,
            step: step.text,
          });
          proposals.push({
            keyword: step.keyword,
            text: step.text,
            path: draft.path,
            line: step.line,
          });
        }
      }
    }

    issues.push(...fileIssues);
    files.push({
      path: draft.path,
      content: draft.content,
      contentHash: contentHash(draft.content),
      scenarioCount: parsed.feature?.scenarios.length ?? 0,
      fingerprints,
      validationStatus: fileIssues.some((issue) => issue.severity === 'error')
        ? 'invalid'
        : 'valid',
      issues: fileIssues,
    });
  }

  const uniqueProposals = new Map<string, StepProposal>();

  for (const proposal of proposals) {
    uniqueProposals.set(`${proposal.keyword}:${proposal.text}`, proposal);
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    stepProposals: [...uniqueProposals.values()],
    scenarioCount,
    files,
  };
}
