// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';
import type {
  CommitInfo,
  CritiqueResult,
  DiffCollection,
  DiffFile,
  ExistingCase,
  FeatureDraft,
  FeaturePoint,
  FilterStats,
  GenerationGranularity,
  GenerationMode,
  GenerationStats,
  GenerationTokenUsage,
  RiskLevel,
  TestLayer,
} from '@gait/shared';
import { RISK_LEVELS, TEST_LAYERS, DEFAULT_GENERATION_GRANULARITY } from '@gait/shared';
import type { StepRegistry, ValidateDraftsResult } from '@gait/runner';
import type { PromptOverrides } from './prompts.js';
import type { LlmClient } from '../llm/llm-client.js';

export const PROMPT_VERSION = 'm4-v1';

/** 提示词里展示的夹具变量（点路径 + 预览值）。 */
export interface FixtureVariable {
  name: string;
  value: string;
}

export const FileSummarySchema = z
  .object({
    path: z.string().min(1),
    intent: z.string().min(1),
    behaviorChanges: z.array(z.string()).default([]),
    modules: z.array(z.string()).default([]),
    risk: z.enum(RISK_LEVELS).default('medium'),
  })
  .strict();

export const SummaryOutputSchema = z
  .object({
    summaries: z.array(FileSummarySchema).default([]),
  })
  .strict();

export type FileSummary = z.infer<typeof FileSummarySchema>;

export const SourceReferenceSchema = z
  .object({
    path: z.string().min(1),
    hunk: z.string().default(''),
    reason: z.string().default(''),
  })
  .strict();

export const FeaturePointDraftSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1),
    description: z.string().default(''),
    kind: z.string().default('other'),
    risk: z.enum(RISK_LEVELS).default('medium'),
    affectedModules: z.array(z.string()).default([]),
    sources: z.array(SourceReferenceSchema).default([]),
    docRefs: z.array(z.string()).default([]),
    suggestedLayer: z.array(z.enum(TEST_LAYERS)).default([]),
  })
  .strict();

export const FeatureExtractionOutputSchema = z
  .object({
    features: z.array(FeaturePointDraftSchema).default([]),
  })
  .strict();

/**
 * step 提议项。模型常见的字段漂移（phrase/innerText/stepText 替代 text）
 * 通过 preprocess 归一化，避免因命名细节导致整个任务失败。
 */
export const StepProposalSchema = z.preprocess(
  (input) => {
    if (input === null || typeof input !== 'object') {
      return input;
    }

    const raw = input as Record<string, unknown>;
    const text = raw['text'] ?? raw['phrase'] ?? raw['stepText'] ?? raw['innerText'] ?? raw['name'];

    return {
      keyword: raw['keyword'] ?? 'Given',
      text,
    };
  },
  z
    .object({
      keyword: z.string().default('Given'),
      text: z.string().min(1),
    })
    .strip(),
);

export const DesignOutputSchema = z
  .object({
    files: z.array(z.object({ path: z.string().min(1), content: z.string().min(1) }).strict()),
    stepProposals: z.array(StepProposalSchema).default([]),
  })
  .strip();

export const CritiqueOutputSchema = z
  .object({
    acceptable: z.boolean(),
    summary: z.string().default(''),
    issues: z
      .array(
        z
          .object({
            severity: z.enum(['error', 'warning']).default('warning'),
            message: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export interface GenerationWorkflowInput {
  tenantId: string;
  projectId: string;
  generationId: string;
  baseSha: string | null;
  headSha: string;
  branch: string | null;
  mode: GenerationMode;
  /** 用例生成颗粒度；旧调用方未传时由 workflow 补默认 medium。 */
  granularity?: GenerationGranularity | undefined;
  /** 本次任务的额外需求说明（如“图片不超过 500*500”）。 */
  extraInstructions?: string | undefined;
  model: string;
  promptVersion: string;
  selection: { modules: string[] } | null;
}

export interface GenerationWorkflowState {
  input: GenerationWorkflowInput;
  commits: CommitInfo[];
  files: DiffFile[];
  stats: FilterStats;
  truncated: boolean;
  summaries: FileSummary[];
  featurePoints: FeaturePoint[];
  existingCases: ExistingCase[];
  drafts: FeatureDraft[];
  /** 模型认为现有脚本库无法表达的缺口（去重后），用于脚本库 draft 提案。 */
  stepProposals: { keyword: string; text: string }[];
  validation: ValidateDraftsResult | null;
  critique: CritiqueResult | null;
  attempts: number;
  feedback: string[];
  outcome: 'awaiting_approval' | 'failed' | 'no_op';
  failureReason: string | null;
  usages: GenerationTokenUsage[];
}

export interface GenerationWorkflowDeps {
  llm: LlmClient;
  collectDiff: () => Promise<DiffCollection>;
  stepRegistry: StepRegistry;
  /** 脚本库目录文本（按模块分组）。给定后提示词会引导优先复用。 */
  scriptCatalog?: string;
  /** 提示词覆盖：system 替换内置默认，extra 作为任务需求追加到各阶段。 */
  promptOverrides?: PromptOverrides;
  /**
   * 当前 suite 可用的夹具变量（`fixture.*` 点路径与示例值）。
   * 传给 design 阶段，避免模型引用不存在的 {{fixture.xxx}} 导致运行期失败。
   */
  fixtureVariables?: readonly FixtureVariable[];
  retrieveExistingCases: (
    featurePoints: FeaturePoint[],
    files: DiffFile[],
  ) => Promise<ExistingCase[]>;
  featurePrefix: string;
  now?: () => number;
}

export interface GenerationWorkflowResult {
  outcome: GenerationWorkflowState['outcome'];
  state: GenerationWorkflowState;
  stats: GenerationStats;
  durationMs: number;
}

export interface FeaturePointCounts {
  high: number;
  medium: number;
  low: number;
}

export function defaultFeatureStats(): GenerationStats {
  return {
    mode: 'range',
    granularity: DEFAULT_GENERATION_GRANULARITY,
    commits: 0,
    filesChanged: 0,
    filesIncluded: 0,
    filesSkipped: 0,
    filesTruncated: 0,
    incomplete: false,
    featurePoints: 0,
    scenarios: 0,
    existingCases: 0,
    covered: 0,
    needsUpdate: 0,
    newCases: 0,
    obsolete: 0,
    retries: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, model: '' },
    durationMs: 0,
  };
}

export function sumUsage(usages: readonly GenerationTokenUsage[]): GenerationTokenUsage {
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      model: total.model.length > 0 ? total.model : usage.model,
    }),
    { inputTokens: 0, outputTokens: 0, model: '' },
  );
}

export function riskOf(value: string): RiskLevel {
  return value === 'high' || value === 'low' ? value : 'medium';
}

export function layerOf(value: string): TestLayer | null {
  return (TEST_LAYERS as readonly string[]).includes(value) ? (value as TestLayer) : null;
}
