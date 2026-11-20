// 本文件所有改动要求遵循 agent-rules 规范
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { GENERATION_LIMITS, repoRelativePathIssues } from '@gait/shared';
import type {
  CoverageRelation,
  DiffFile,
  ExistingCase,
  FeatureDraft,
  FeaturePoint,
  GenerationStats,
  RiskLevel,
  TestLayer,
} from '@gait/shared';
import { validateFeatureDrafts } from '@gait/runner';
import type { FileSummary } from './types.js';
import {
  CritiqueOutputSchema,
  DesignOutputSchema,
  FeatureExtractionOutputSchema,
  SummaryOutputSchema,
  defaultFeatureStats,
  layerOf,
  riskOf,
  sumUsage,
} from './types.js';
import type {
  GenerationWorkflowDeps,
  GenerationWorkflowInput,
  GenerationWorkflowResult,
  GenerationWorkflowState,
} from './types.js';
import {
  CRITIQUE_SYSTEM,
  DESIGN_SYSTEM,
  EXTRACT_SYSTEM,
  SUMMARIZE_SYSTEM,
  buildCritiquePrompt,
  buildDesignPrompt,
  buildExtractPrompt,
  buildSummarizePrompt,
} from './prompts.js';
import { generateStructured } from '../llm/llm-client.js';

const WorkflowAnnotation = Annotation.Root({
  state: Annotation<GenerationWorkflowState>({
    reducer: (_previous, next) => next,
  }),
});

type WorkflowAnnotationState = typeof WorkflowAnnotation.State;

function inferModulesFromPath(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const ignored = new Set(['src', 'app', 'apps', 'packages', 'lib', 'internal']);
  const candidate = segments
    .slice(0, -1)
    .find((segment) => !ignored.has(segment) && !segment.startsWith('.'));

  return candidate === undefined ? [] : [candidate];
}

function normalizeSummaries(
  summaries: readonly FileSummary[],
  files: readonly DiffFile[],
): FileSummary[] {
  const included = files.filter((file) => !file.skipped);
  const byPath = new Map(summaries.map((summary) => [summary.path, summary]));

  return included.map((file) => {
    const summary = byPath.get(file.path);

    if (summary !== undefined) {
      return {
        ...summary,
        modules: summary.modules.length > 0 ? summary.modules : inferModulesFromPath(file.path),
      };
    }

    return {
      path: file.path,
      intent: `${file.status} ${file.category} file`,
      behaviorChanges: [],
      modules: inferModulesFromPath(file.path),
      risk: file.category === 'api' || file.category === 'database' ? 'high' : 'medium',
    } satisfies FileSummary;
  });
}

function defaultLayers(kind: string): TestLayer[] {
  if (kind === 'api') {
    return ['api'];
  }

  if (kind === 'frontend') {
    return ['ui'];
  }

  if (kind === 'database') {
    return ['db'];
  }

  if (kind === 'docs' || kind === 'refactor') {
    return [];
  }

  return ['api'];
}

function normalizeFeaturePoints(
  rawFeatures: readonly {
    title: string;
    description: string;
    kind: string;
    risk: RiskLevel;
    affectedModules: string[];
    sources: { path: string; hunk: string; reason: string }[];
    docRefs: string[];
    suggestedLayer: TestLayer[];
  }[],
  files: readonly DiffFile[],
  summaries: readonly FileSummary[],
  selection: { modules: string[] } | null,
): FeaturePoint[] {
  const included = files.filter((file) => !file.skipped);
  const includedPaths = new Set(included.map((file) => file.path));
  const docPaths = new Set(
    included.filter((file) => file.isDoc || file.isOpenApi).map((file) => file.path),
  );
  const summariesByPath = new Map(summaries.map((summary) => [summary.path, summary]));
  const fallbackFile = included[0];
  const points: FeaturePoint[] = [];
  const seen = new Set<string>();

  for (const raw of rawFeatures) {
    const title = raw.title.trim();

    if (title.length === 0) {
      continue;
    }

    const sources = raw.sources.filter((source) => includedPaths.has(source.path));

    if (sources.length === 0 && fallbackFile !== undefined) {
      sources.push({
        path: fallbackFile.path,
        hunk: fallbackFile.hunks[0]?.header ?? '',
        reason: 'changed file',
      });
    }

    if (sources.length === 0) {
      continue;
    }

    const modules =
      raw.affectedModules.length > 0
        ? raw.affectedModules
        : [
            ...new Set(
              sources.flatMap((source) => summariesByPath.get(source.path)?.modules ?? []),
            ),
          ];

    const affectedModules =
      modules.length > 0 ? modules : inferModulesFromPath(sources[0]?.path ?? '');

    if (selection !== null && selection.modules.length > 0) {
      if (!affectedModules.some((module) => selection.modules.includes(module))) {
        continue;
      }
    }

    const dedupeKey = `${title.toLowerCase()}|${affectedModules.join(',')}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    const normalizedModules = affectedModules.length > 0 ? affectedModules : ['general'];
    const suggestedLayer = raw.suggestedLayer.filter((layer) => layerOf(layer) !== null);

    points.push({
      id: `FP-${String(points.length + 1).padStart(3, '0')}`,
      title,
      description: raw.description.trim(),
      kind: raw.kind,
      risk: riskOf(raw.risk),
      affectedModules: normalizedModules,
      sources: sources.map((source) => ({
        path: source.path,
        hunk: source.hunk,
        reason: source.reason,
      })),
      docRefs: raw.docRefs.filter((reference) => docPaths.has(reference)),
      existingCoverage: [],
      suggestedLayer: suggestedLayer.length > 0 ? suggestedLayer : defaultLayers(raw.kind),
    });
  }

  return points;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function normalizeDrafts(
  files: readonly { path: string; content: string }[],
  featurePoints: readonly FeaturePoint[],
  existingCases: readonly ExistingCase[],
  prefixInput: string,
): FeatureDraft[] {
  const prefix = prefixInput.replace(/\/+$/, '');
  const existingPaths = new Set(existingCases.map((existing) => existing.featurePath));
  const usedPaths = new Set<string>();
  const drafts: FeatureDraft[] = [];

  for (const [index, file] of files.entries()) {
    const moduleKey = (
      featurePoints[index]?.affectedModules[0] ??
      featurePoints[0]?.affectedModules[0] ??
      'general'
    )
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const titleSlug =
      slugify(file.path.replace(/^.*\//, '').replace(/\.feature$/, '')) ||
      slugify(featurePoints[index]?.title ?? '') ||
      `generated-${index + 1}`;
    let path = file.path.trim().replace(/\\/g, '/');

    if (
      !path.startsWith(`${prefix}/`) ||
      !path.endsWith('.feature') ||
      repoRelativePathIssues(path).length > 0
    ) {
      path = `${prefix}/${moduleKey}/${titleSlug}.feature`;
    }

    let candidate = path;
    let suffix = 2;

    while (usedPaths.has(candidate)) {
      candidate = path.replace(/\.feature$/, `-${suffix}.feature`);
      suffix += 1;
    }

    usedPaths.add(candidate);
    drafts.push({
      path: candidate,
      content: file.content,
      action: existingPaths.has(candidate) ? 'update' : 'create',
    });
  }

  return drafts;
}

function feedbackFromValidation(
  validation: NonNullable<GenerationWorkflowState['validation']>,
): string[] {
  return validation.issues
    .filter((issue) => issue.severity === 'error')
    .slice(0, 30)
    .map(
      (issue) =>
        `${issue.code}: ${issue.message}${issue.path === undefined ? '' : ` [${issue.path}${issue.line === undefined ? '' : `:${issue.line}`}]`}`,
    );
}

function coverageCounts(existingCases: readonly ExistingCase[]): Record<CoverageRelation, number> {
  const counts: Record<CoverageRelation, number> = {
    covered: 0,
    needs_update: 0,
    new: 0,
    obsolete: 0,
  };

  for (const existing of existingCases) {
    counts[existing.coverage] += 1;
  }

  return counts;
}

function statsFor(state: GenerationWorkflowState, durationMs: number): GenerationStats {
  const base = defaultFeatureStats();
  const coverage = coverageCounts(state.existingCases);
  const coveredModules = new Set(
    state.existingCases
      .filter((existing) => existing.coverage === 'covered')
      .map((existing) => existing.moduleKey),
  );
  const tokenUsage = sumUsage(state.usages);

  return {
    ...base,
    commits: state.commits.length,
    filesChanged: state.stats.totalFiles,
    filesIncluded: state.stats.includedFiles,
    filesSkipped: state.stats.skippedFiles,
    featurePoints: state.featurePoints.length,
    scenarios: state.validation?.scenarioCount ?? 0,
    existingCases: state.existingCases.length,
    covered: coverage.covered,
    needsUpdate: coverage.needs_update,
    newCases: state.featurePoints.filter(
      (featurePoint) => !featurePoint.affectedModules.some((module) => coveredModules.has(module)),
    ).length,
    obsolete: coverage.obsolete,
    retries: Math.max(0, state.attempts - 1),
    tokenUsage,
    durationMs,
  };
}

function initialState(input: GenerationWorkflowInput): GenerationWorkflowState {
  return {
    input,
    commits: [],
    files: [],
    stats: {
      totalFiles: 0,
      includedFiles: 0,
      skippedFiles: 0,
      truncatedFiles: 0,
      sensitiveFiles: 0,
      totalBytes: 0,
      includedBytes: 0,
      skippedByReason: {},
    },
    truncated: false,
    summaries: [],
    featurePoints: [],
    existingCases: [],
    drafts: [],
    validation: null,
    critique: null,
    attempts: 0,
    feedback: [],
    outcome: 'failed',
    failureReason: null,
    usages: [],
  };
}

/**
 * Graph A 的可执行子图：collect → summarize → extract → retrieve → design → validate → critique。
 * 审批是持久化状态边界：本函数返回 awaiting_approval，提交由 approval API 执行。
 */
export async function runGenerationWorkflow(
  deps: GenerationWorkflowDeps,
  input: GenerationWorkflowInput,
): Promise<GenerationWorkflowResult> {
  const clock = deps.now ?? (() => Date.now());
  const startedAt = clock();
  const initial = initialState(input);

  const graph = new StateGraph(WorkflowAnnotation)
    .addNode('collect_git', async (state: WorkflowAnnotationState) => {
      const collection = await deps.collectDiff();
      const included = collection.files.filter((file) => !file.skipped);
      const next: GenerationWorkflowState = {
        ...state.state,
        commits: collection.commits,
        files: collection.files,
        stats: collection.stats,
        truncated: collection.truncated,
        outcome: included.length === 0 ? 'no_op' : 'awaiting_approval',
        failureReason: included.length === 0 ? 'No relevant file changes' : null,
      };

      return { state: next };
    })
    .addNode('summarize_files', async (state: WorkflowAnnotationState) => {
      const result = await generateStructured(deps.llm, SummaryOutputSchema, {
        system: SUMMARIZE_SYSTEM,
        user: buildSummarizePrompt(state.state.files),
        temperature: 0.1,
        maxTokens: 4_096,
      });
      const summaries = normalizeSummaries(result.value.summaries, state.state.files);

      return {
        state: { ...state.state, summaries, usages: [...state.state.usages, ...result.usages] },
      };
    })
    .addNode('extract_features', async (state: WorkflowAnnotationState) => {
      const result = await generateStructured(deps.llm, FeatureExtractionOutputSchema, {
        system: EXTRACT_SYSTEM,
        user: buildExtractPrompt(
          state.state.summaries,
          state.state.files,
          state.state.input.selection,
        ),
        temperature: 0.1,
        maxTokens: 4_096,
      });
      const featurePoints = normalizeFeaturePoints(
        result.value.features,
        state.state.files,
        state.state.summaries,
        state.state.input.selection,
      );

      return {
        state: {
          ...state.state,
          featurePoints,
          usages: [...state.state.usages, ...result.usages],
          outcome: featurePoints.length === 0 ? 'no_op' : 'awaiting_approval',
          failureReason: featurePoints.length === 0 ? 'No feature points found' : null,
        },
      };
    })
    .addNode('retrieve_existing_cases', async (state: WorkflowAnnotationState) => {
      const existingCases = await deps.retrieveExistingCases(
        state.state.featurePoints,
        state.state.files,
      );

      return { state: { ...state.state, existingCases } };
    })
    .addNode('design_tests', async (state: WorkflowAnnotationState) => {
      const result = await generateStructured(deps.llm, DesignOutputSchema, {
        system: DESIGN_SYSTEM,
        user: buildDesignPrompt(state.state, deps.stepRegistry.stepPatterns, deps.featurePrefix),
        temperature: 0.1,
        maxTokens: 8_192,
      });
      const drafts = normalizeDrafts(
        result.value.files,
        state.state.featurePoints,
        state.state.existingCases,
        deps.featurePrefix,
      );

      return {
        state: {
          ...state.state,
          drafts,
          attempts: state.state.attempts + 1,
          usages: [...state.state.usages, ...result.usages],
        },
      };
    })
    .addNode('validate_tests', async (state: WorkflowAnnotationState) => {
      const existingFingerprints = new Set(
        state.state.existingCases.map((existing) => existing.fingerprint),
      );
      const validation = validateFeatureDrafts({
        drafts: state.state.drafts,
        stepRegistry: deps.stepRegistry,
        existingFingerprints,
        featurePrefix: deps.featurePrefix,
      });

      return {
        state: {
          ...state.state,
          validation,
          feedback: feedbackFromValidation(validation),
        },
      };
    })
    .addNode('critique', async (state: WorkflowAnnotationState) => {
      const result = await generateStructured(deps.llm, CritiqueOutputSchema, {
        system: CRITIQUE_SYSTEM,
        user: buildCritiquePrompt(state.state.featurePoints, state.state),
        temperature: 0.1,
        maxTokens: 3_072,
      });
      const hasError = result.value.issues.some((issue) => issue.severity === 'error');
      const critique = {
        acceptable: result.value.acceptable && !hasError,
        summary: result.value.summary,
        issues: result.value.issues,
      };

      return {
        state: {
          ...state.state,
          critique,
          feedback: critique.acceptable
            ? []
            : critique.issues.slice(0, 30).map((issue) => `critique: ${issue.message}`),
          usages: [...state.state.usages, ...result.usages],
        },
      };
    })
    .addNode('approval', async (state: WorkflowAnnotationState) => ({
      state: {
        ...state.state,
        outcome: 'awaiting_approval' as const,
        failureReason: null,
      },
    }))
    .addNode('no_op', async (state: WorkflowAnnotationState) => ({
      state: { ...state.state, outcome: 'no_op' as const },
    }))
    .addNode('fail', async (state: WorkflowAnnotationState) => ({
      state: {
        ...state.state,
        outcome: 'failed' as const,
        failureReason:
          state.state.validation !== null && !state.state.validation.valid
            ? 'Generated drafts failed validation'
            : 'Generated drafts failed critique',
      },
    }))
    .addEdge(START, 'collect_git')
    .addConditionalEdges(
      'collect_git',
      (state: WorkflowAnnotationState) =>
        state.state.outcome === 'no_op' ? 'no_op' : 'summarize_files',
      { no_op: 'no_op', summarize_files: 'summarize_files' },
    )
    .addEdge('summarize_files', 'extract_features')
    .addConditionalEdges(
      'extract_features',
      (state: WorkflowAnnotationState) =>
        state.state.outcome === 'no_op' ? 'no_op' : 'retrieve_existing_cases',
      { no_op: 'no_op', retrieve_existing_cases: 'retrieve_existing_cases' },
    )
    .addEdge('retrieve_existing_cases', 'design_tests')
    .addEdge('design_tests', 'validate_tests')
    .addConditionalEdges(
      'validate_tests',
      (state: WorkflowAnnotationState) => {
        if (state.state.validation?.valid === true) {
          return 'critique';
        }

        return state.state.attempts <= GENERATION_LIMITS.MAX_RETRIES ? 'design_tests' : 'fail';
      },
      { design_tests: 'design_tests', critique: 'critique', fail: 'fail' },
    )
    .addConditionalEdges(
      'critique',
      (state: WorkflowAnnotationState) => {
        if (state.state.critique?.acceptable === true) {
          return 'approval';
        }

        return state.state.attempts <= GENERATION_LIMITS.MAX_RETRIES ? 'design_tests' : 'fail';
      },
      { design_tests: 'design_tests', approval: 'approval', fail: 'fail' },
    )
    .addEdge('approval', END)
    .addEdge('no_op', END)
    .addEdge('fail', END)
    .compile();

  const finalState = await graph
    .invoke({ state: initial })
    .then((result) => result.state as GenerationWorkflowState)
    .catch((error: unknown): GenerationWorkflowState => ({
      ...initial,
      outcome: 'failed',
      failureReason:
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }));

  const durationMs = Math.max(0, clock() - startedAt);

  return {
    outcome: finalState.outcome,
    state: finalState,
    stats: statsFor(finalState, durationMs),
    durationMs,
  };
}

export function parseRisk(value: string): RiskLevel {
  return riskOf(value);
}
