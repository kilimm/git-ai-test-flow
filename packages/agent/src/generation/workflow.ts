// 本文件所有改动要求遵循 agent-rules 规范
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  DEFAULT_GENERATION_GRANULARITY,
  GENERATION_LIMITS,
  buildModuleTree,
  matchesModuleSelection,
  moduleAncestry,
  normalizeModuleKey,
  normalizeModuleKeys,
  repoRelativePathIssues,
} from '@gait/shared';
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

/**
 * 从文件路径推导模块 key（层级化）。
 *
 * 规则（确定性，不依赖 LLM）：
 * 1. 去掉文件名 + 扩展名，只保留目录段；
 * 2. 跳过脚手架与分层目录：src/app/apps/packages/lib/internal/test/tests/e2e/__tests__；
 * 3. 跳过以 `.` 开头的隐藏目录、以及 `v1`/`v2` 这类纯版本段；
 * 4. 剩余目录段取全部（最多 MAX_MODULE_DEPTH 段）作为层级 key，例如
 *    `src/modules/posts/comments/service.ts` → `posts.comments`；
 * 5. 每段按 slug 规则规范化，无法识别时回退为单段 `general`。
 *
 * 选择「全部目录段」而不是首段，是因为仓库普遍使用 `modules/<a>/<b>` 分层，
 * 只取首段会把所有功能归到 `modules`，丢失层级。
 */
const IGNORED_PATH_SEGMENTS = new Set([
  'src',
  'app',
  'apps',
  'packages',
  'lib',
  'internal',
  'server',
  'client',
  'api',
  'routes',
  'controllers',
  'services',
  'handlers',
  'test',
  'tests',
  'e2e',
  '__tests__',
  '__mocks__',
  'spec',
  'migrations',
  'scripts',
  'docs',
  'modules',
]);

const VERSION_SEGMENT = /^v\d+$/;

const MAX_MODULE_DEPTH = 3;

export function inferModulesFromPath(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const directories = segments.slice(0, -1);
  // 下划线在目录名里通常表示层级（`posts_comments`），统一展开为多段，
  // 与 LLM 给出的 `posts.comments` 收敛到同一 key。
  const expanded = directories.flatMap((segment) =>
    /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(segment) ? segment.split('_') : [segment],
  );
  const meaningful = expanded
    .filter((segment) => !segment.startsWith('.'))
    .filter((segment) => !IGNORED_PATH_SEGMENTS.has(segment.toLowerCase()))
    .filter((segment) => !VERSION_SEGMENT.test(segment.toLowerCase()))
    .slice(-MAX_MODULE_DEPTH);
  // 兜底：目录段全部被跳过时（如 `src/api/posts.ts`），退化为 general；
  // 不用父目录名，因为它通常是 `api`/`routes` 之类无业务含义的分层名。
  const fallback: string[] = [];
  const picked = meaningful.length > 0 ? meaningful : fallback;
  const key = normalizeModuleKey(picked.join('.'));

  return key === null ? ['general'] : [key];
}

/** 统一收敛模块列表：规范化、去重、忽略 `general` 之外的失败回退。 */
function normalizeModules(modules: readonly string[], fallbackPath: string): string[] {
  const normalized = normalizeModuleKeys(modules);

  return normalized.length > 0 ? normalized : inferModulesFromPath(fallbackPath);
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
        modules: normalizeModules(summary.modules, file.path),
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

    const sourceModules = [
      ...new Set(sources.flatMap((source) => summariesByPath.get(source.path)?.modules ?? [])),
    ];
    const affectedModules = normalizeModules(
      raw.affectedModules.length > 0 ? raw.affectedModules : sourceModules,
      sources[0]?.path ?? '',
    );

    // 前缀匹配：选 posts 命中 posts.comments；选 posts.comments 不会命中 posts。
    if (selection !== null && !matchesModuleSelection(affectedModules, selection.modules)) {
      continue;
    }

    const dedupeKey = `${title.toLowerCase()}|${affectedModules.join(',')}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    const normalizedModules = affectedModules;
    const suggestedLayer = raw.suggestedLayer.filter((layer) => layerOf(layer) !== null);

    points.push({
      id: `FP-${String(points.length + 1).padStart(3, '0')}`,
      title,
      description: raw.description.trim(),
      kind: raw.kind,
      risk: riskOf(raw.risk),
      affectedModules: normalizedModules,
      // 祖先链用于模块树展示/过滤索引（posts.comments → posts, posts.comments）。
      modulePath: [...new Set(normalizedModules.flatMap((module) => moduleAncestry(module)))],
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

/**
 * 合并 step 提议：按规范化句式去重（忽略大小写/多余空格/引号差异），
 * 避免同一缺口在多轮重生成里反复累积。
 */
function mergeStepProposals(
  previous: readonly { keyword: string; text: string }[],
  next: readonly { keyword: string; text: string }[],
): { keyword: string; text: string }[] {
  const keyOf = (item: { text: string }): string =>
    item.text
      .toLowerCase()
      .replace(/["'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const seen = new Set(previous.map(keyOf));
  const merged = [...previous];

  for (const item of next) {
    const key = keyOf(item);

    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push({ keyword: item.keyword, text: item.text });
  }

  return merged.slice(0, 50);
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
    // 保留层级（点号分隔），与 FeaturePoint.affectedModules 及校验器的 MODULE_TAG 保持一致。
    const moduleKey =
      normalizeModuleKey(
        featurePoints[index]?.affectedModules[0] ??
          featurePoints[0]?.affectedModules[0] ??
          'general',
      ) ?? 'general';
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
      content: ensureModuleTag(file.content, moduleKey),
      action: existingPaths.has(candidate) ? 'update' : 'create',
    });
  }

  return drafts;
}

/**
 * 保底：模型偶尔会漏写 feature 级 @module 标签，而校验器对此是致命错误。
 * 当内容中完全没有 @module: 标签时，在 Feature: 之前补上一行模块标签。
 * 仅为格式补全，不修改任何场景内容。
 */
function ensureModuleTag(content: string, moduleKey: string): string {
  if (/@module:\s*\S/.test(content)) {
    return content;
  }

  const tag = `@module:${moduleKey}`;
  const featureLine = /^(\s*)(Feature:)/m.exec(content);

  if (featureLine === null) {
    return `${tag}\n${content}`;
  }

  const at = featureLine.index;

  return `${content.slice(0, at)}${tag}\n${content.slice(at)}`;
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

/**
 * 模块树计数：每个功能点归属到 affectedModules 中「最深」的 key（叶子），
 * 避免同一功能点把父模块 direct 也 +1，导致前端展示重复。
 */
function moduleCounts(featurePoints: readonly FeaturePoint[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();

  for (const featurePoint of featurePoints) {
    const keys = normalizeModuleKeys(featurePoint.affectedModules);
    const leafKeys = keys.filter(
      (key) => !keys.some((other) => other !== key && other.startsWith(`${key}.`)),
    );
    const target = leafKeys.length > 0 ? leafKeys : ['general'];

    for (const key of target) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([key, count]) => ({ key, count }));
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
  // 截断或跳过部分文件时，baseline 生成并不能代表"整个代码库"，必须显式透出而非静默丢文件。
  const incomplete =
    state.truncated || state.stats.truncatedFiles > 0 || state.stats.skippedFiles > 0;

  return {
    ...base,
    mode: state.input.mode,
    granularity: state.input.granularity ?? base.granularity,
    commits: state.commits.length,
    filesChanged: state.stats.totalFiles,
    filesIncluded: state.stats.includedFiles,
    filesSkipped: state.stats.skippedFiles,
    filesTruncated: state.stats.truncatedFiles,
    incomplete,
    modules: buildModuleTree(moduleCounts(state.featurePoints)),
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
  // 旧调用方（未传 granularity）统一收敛为默认 medium，保证 prompt 与统计一致。
  const normalizedInput: GenerationWorkflowInput = {
    ...input,
    granularity: input.granularity ?? DEFAULT_GENERATION_GRANULARITY,
  };

  return {
    input: normalizedInput,
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
    stepProposals: [],
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
        user: buildSummarizePrompt(state.state.files, state.state.input.mode),
        temperature: 0.1,
        maxTokens: 32_768,
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
          state.state.input.granularity,
          state.state.input.mode,
        ),
        temperature: 0.1,
        maxTokens: 32_768,
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
        user: buildDesignPrompt(
          state.state,
          deps.stepRegistry.stepPatterns,
          deps.featurePrefix,
          deps.scriptCatalog,
        ),
        temperature: 0.1,
        maxTokens: 65_536,
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
          stepProposals: mergeStepProposals(state.state.stepProposals, result.value.stepProposals),
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
        maxTokens: 16_384,
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
        failureReason: describeFailure(state.state),
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

        // MAX_RETRIES 表示「最多重试几次」，attempts 已包含首次设计：
        // attempts < MAX_RETRIES 才是还能再试。用 <= 会多跑一轮（3 变 4）。
        return state.state.attempts < GENERATION_LIMITS.MAX_RETRIES ? 'design_tests' : 'fail';
      },
      { design_tests: 'design_tests', critique: 'critique', fail: 'fail' },
    )
    .addConditionalEdges(
      'critique',
      (state: WorkflowAnnotationState) => {
        if (state.state.critique?.acceptable === true) {
          return 'approval';
        }

        // MAX_RETRIES 表示「最多重试几次」，attempts 已包含首次设计：
        // attempts < MAX_RETRIES 才是还能再试。用 <= 会多跑一轮（3 变 4）。
        return state.state.attempts < GENERATION_LIMITS.MAX_RETRIES ? 'design_tests' : 'fail';
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
    .catch((error: unknown): GenerationWorkflowState => {
      const reason = error instanceof Error ? error.message : String(error);

      return {
        ...initial,
        outcome: 'failed',
        failureReason: reason.slice(0, 1_500),
      };
    });

  const durationMs = Math.max(0, clock() - startedAt);

  return {
    outcome: finalState.outcome,
    state: finalState,
    stats: statsFor(finalState, durationMs),
    durationMs,
  };
}

/** 汇总失败原因：把校验错误具体内容透出，避免只有笼统一句话而无法定位。 */
function describeFailure(state: GenerationWorkflowState): string {
  const validation = state.validation;

  if (validation !== null && !validation.valid) {
    const issues = validation.issues
      .filter((issue) => issue.severity === 'error')
      .slice(0, 8)
      .map((issue) => `${issue.path}: ${issue.message}`);

    return `Generated drafts failed validation: ${issues.join(' | ').slice(0, 1_200)}`;
  }

  const critiqueIssues =
    state.critique?.issues
      .slice(0, 8)
      .map((issue) => issue.message)
      .join(' | ') ?? '';

  return `Generated drafts failed critique: ${critiqueIssues.slice(0, 1_200)}`;
}

export function parseRisk(value: string): RiskLevel {
  return riskOf(value);
}
