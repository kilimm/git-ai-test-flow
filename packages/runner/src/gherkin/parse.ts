// 本文件所有改动要求遵循 agent-rules 规范
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type { Feature, GherkinDocument, Scenario, Step } from '@cucumber/messages';
import type { ValidationIssue } from '@gait/shared';

export type EffectiveStepType = 'Context' | 'Action' | 'Outcome' | 'unknown';

export interface ParsedStep {
  keyword: string;
  keywordType: EffectiveStepType;
  text: string;
  line: number;
  docString: string | null;
  dataTable: string[][] | null;
}

export interface ParsedScenario {
  name: string;
  line: number;
  tags: string[];
  steps: ParsedStep[];
  hasExamples: boolean;
}

export interface ParsedFeature {
  name: string;
  line: number;
  tags: string[];
  language: string;
  backgroundSteps: ParsedStep[];
  scenarios: ParsedScenario[];
}

export interface ParseFeatureResult {
  feature: ParsedFeature | null;
  errors: ValidationIssue[];
}

function tagsOf(tags: readonly { name: string }[] | undefined): string[] {
  return (tags ?? []).map((tag) => tag.name.replace(/^@/, ''));
}

function stepFromAst(step: Step, previousType: EffectiveStepType): ParsedStep {
  const rawType = step.keywordType;

  const keywordType: EffectiveStepType =
    rawType === 'Context'
      ? 'Context'
      : rawType === 'Action'
        ? 'Action'
        : rawType === 'Outcome'
          ? 'Outcome'
          : rawType === 'Conjunction'
            ? previousType
            : 'unknown';

  return {
    keyword: step.keyword.trim(),
    keywordType,
    text: step.text.trim(),
    line: step.location.line,
    docString: step.docString?.content ?? null,
    dataTable:
      step.dataTable === undefined || step.dataTable === null
        ? null
        : step.dataTable.rows.map((row) => row.cells.map((cell) => cell.value)),
  };
}

function stepsOf(steps: readonly Step[]): ParsedStep[] {
  const result: ParsedStep[] = [];
  let previous: EffectiveStepType = 'unknown';

  for (const step of steps) {
    const parsed = stepFromAst(step, previous);
    result.push(parsed);
    previous = parsed.keywordType;
  }

  return result;
}

function scenarioFromAst(scenario: Scenario): ParsedScenario {
  return {
    name: scenario.name.trim(),
    line: scenario.location.line,
    tags: tagsOf(scenario.tags),
    steps: stepsOf(scenario.steps),
    hasExamples: (scenario.examples ?? []).length > 0,
  };
}

function collectFromFeatureChildren(feature: Feature): {
  backgroundSteps: ParsedStep[];
  scenarios: ParsedScenario[];
} {
  const backgroundSteps: ParsedStep[] = [];
  const scenarios: ParsedScenario[] = [];

  for (const child of feature.children) {
    if (child.background !== undefined) {
      backgroundSteps.push(...stepsOf(child.background.steps));
    } else if (child.scenario !== undefined) {
      scenarios.push(scenarioFromAst(child.scenario));
    } else if (child.rule !== undefined) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.background !== undefined) {
          backgroundSteps.push(...stepsOf(ruleChild.background.steps));
        } else if (ruleChild.scenario !== undefined) {
          scenarios.push(scenarioFromAst(ruleChild.scenario));
        }
      }
    }
  }

  return { backgroundSteps, scenarios };
}

function errorLine(message: string): number | undefined {
  const match = /\((\d+):(\d+)\)/.exec(message);

  return match === null ? undefined : Number(match[1]);
}

export function parseFeatureSource(source: string): ParseFeatureResult {
  let document: GherkinDocument;

  try {
    const parser = new Parser(
      new AstBuilder(IdGenerator.incrementing()),
      new GherkinClassicTokenMatcher(),
    );
    document = parser.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = errorLine(message);

    return {
      feature: null,
      errors: [
        {
          code: 'GHERKIN_SYNTAX_ERROR',
          severity: 'error',
          message,
          ...(line === undefined ? {} : { line }),
        },
      ],
    };
  }

  if (document.feature === undefined) {
    return {
      feature: null,
      errors: [
        {
          code: 'GHERKIN_FEATURE_MISSING',
          severity: 'error',
          message: 'Feature is missing',
        },
      ],
    };
  }

  const feature = document.feature;
  const { backgroundSteps, scenarios } = collectFromFeatureChildren(feature);
  const errors: ValidationIssue[] = [];

  if (scenarios.length === 0) {
    errors.push({
      code: 'GHERKIN_SCENARIO_MISSING',
      severity: 'error',
      message: 'Feature must contain at least one scenario',
      line: feature.location.line,
    });
  }

  for (const scenario of scenarios) {
    if (scenario.steps.length === 0) {
      errors.push({
        code: 'GHERKIN_STEP_MISSING',
        severity: 'error',
        message: `Scenario "${scenario.name}" must contain at least one step`,
        line: scenario.line,
      });
    }
  }

  return {
    feature: {
      name: feature.name.trim(),
      line: feature.location.line,
      tags: tagsOf(feature.tags),
      language: feature.language,
      backgroundSteps,
      scenarios,
    },
    errors,
  };
}
