// 本文件所有改动要求遵循 agent-rules 规范
import {
  RepairAttemptRepository,
  RunCaseRepository,
  RunEventRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, RunCase } from '@gait/db';
import { ANALYSIS_LIMITS, RUN_ERROR_CODE, isTerminalRunStatus } from '@gait/shared';
import type {
  AttributionResult,
  Classification,
  DiffFile,
  EvidencePack,
  GenerationTokenUsage,
  RepairReviewStatus,
} from '@gait/shared';
import { buildCaseEvidence, evidenceRefs } from './evidence.js';
import { attributeWithLlm, combineAttributions } from './llm-attribution.js';
import { ruleSignalsFromEvidence, decideByRules } from './rules.js';
import { suggestionOnlyGuard } from './repair-guard.js';
import { proposeTestRepair, simplePatchDiff } from './repair-proposal.js';
import type { LlmClient } from '../llm/llm-client.js';

const ENVIRONMENT_STEP_CODES = new Set<string>([
  RUN_ERROR_CODE.DB_CONNECTION_FAILED,
  RUN_ERROR_CODE.DB_NOT_CONFIGURED,
  RUN_ERROR_CODE.ENV_UNHEALTHY,
  RUN_ERROR_CODE.FIXTURE_FAILED,
]);

export interface AnalyzeRunOptions {
  db: AppDatabase;
  tenantId: string;
  runId: string;
  dataDir: string;
  llm?: LlmClient | null;
  llmModel?: string | null;
  readSuiteFile?: (relativePath: string) => string | null;
  /** 测试或调用方已采集的 diff；缺省时从产品 mirror 读取。 */
  diff?: DiffFile[] | null;
  now?: () => number;
}

export interface AnalyzeRunSummary {
  analyzed: number;
  rule: number;
  llm: number;
  fallback: number;
  usage: GenerationTokenUsage;
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (json === null || json === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function failedStepOf(pack: EvidencePack): (typeof pack.steps)[number] | null {
  return pack.steps.find((step) => step.status === 'failed' || step.status === 'error') ?? null;
}

function runErrorCode(json: string | null): string | null {
  if (json === null) {
    return null;
  }

  const code = parseObject(json).code;

  return typeof code === 'string' ? code : null;
}

/**
 * Graph B 归因阶段：
 * - 对失败用例构建证据包 → 规则 → 必要时 LLM；
 * - 证据不足回退 unknown，代码 Bug 禁止改测试；
 * - test_bug 只生成修复建议并经过 guard，P0 不自动应用。
 */
export async function analyzeRun(options: AnalyzeRunOptions): Promise<AnalyzeRunSummary> {
  const clock = options.now ?? (() => Date.now());
  const runRepository = new RunRepository(options.db, options.tenantId);
  const caseRepository = new RunCaseRepository(options.db, options.tenantId);
  const eventRepository = new RunEventRepository(options.db, options.tenantId);
  const repairRepository = new RepairAttemptRepository(options.db, options.tenantId);
  const run = await runRepository.findById(options.runId);

  if (run === undefined) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  if (run.status === 'canceled' || isTerminalRunStatus(run.status)) {
    return {
      analyzed: 0,
      rule: 0,
      llm: 0,
      fallback: 0,
      usage: { inputTokens: 0, outputTokens: 0, model: options.llmModel ?? 'none' },
    };
  }

  const active = await runRepository.updateActive(run.id, { status: 'analyzing' }, clock());

  if (active === undefined) {
    return {
      analyzed: 0,
      rule: 0,
      llm: 0,
      fallback: 0,
      usage: { inputTokens: 0, outputTokens: 0, model: options.llmModel ?? 'none' },
    };
  }

  const cases = await caseRepository.listByRun(run.id);
  const runCode = runErrorCode(run.errorJson);
  const usage: GenerationTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    model: options.llmModel ?? 'none',
  };
  const summary: AnalyzeRunSummary = {
    analyzed: 0,
    rule: 0,
    llm: 0,
    fallback: 0,
    usage,
  };
  let llmCalls = 0;

  for (const runCase of cases) {
    if (runCase.status !== 'failed' && runCase.status !== 'error') {
      continue;
    }

    let pack: EvidencePack;

    try {
      pack = await buildCaseEvidence({
        db: options.db,
        tenantId: options.tenantId,
        runId: run.id,
        runCaseId: runCase.id,
        dataDir: options.dataDir,
        ...(options.diff === undefined ? {} : { diff: options.diff }),
        ...(options.readSuiteFile === undefined ? {} : { readSuiteFile: options.readSuiteFile }),
        now: clock,
      });
    } catch {
      continue;
    }

    const allowedRefs = [...new Set([...evidenceRefs(pack), 'environment'])];
    const failedStep = failedStepOf(pack);
    const stepErrorCode = failedStep?.error?.code ?? null;
    const rule = decideByRules(
      ruleSignalsFromEvidence(pack, {
        runErrorCode: runCode,
        environmentErrorCode:
          stepErrorCode !== null && ENVIRONMENT_STEP_CODES.has(stepErrorCode)
            ? stepErrorCode
            : null,
        allowedRefs,
      }),
    );
    let attribution: AttributionResult = rule;
    let usedLlm = false;

    if (
      options.llm !== undefined &&
      options.llm !== null &&
      llmCalls < ANALYSIS_LIMITS.MAX_LLM_CASES &&
      (rule.verdict === 'unknown' || rule.confidence < ANALYSIS_LIMITS.RULE_OVERRIDE_THRESHOLD)
    ) {
      usedLlm = true;
      llmCalls += 1;

      const llmResult = await attributeWithLlm({
        client: options.llm,
        pack,
        rule,
        allowedRefs,
      });

      if (llmResult !== null) {
        attribution = combineAttributions(rule, llmResult.attribution);
        usage.inputTokens += llmResult.usage.inputTokens;
        usage.outputTokens += llmResult.usage.outputTokens;
        usage.model = llmResult.usage.model;
      }
    }

    if (attribution.source === 'llm') {
      summary.llm += 1;
    } else if (attribution.source === 'fallback') {
      summary.fallback += 1;
    } else {
      summary.rule += 1;
    }

    summary.analyzed += 1;
    const previousEvidence = parseObject(runCase.evidenceJson);
    await caseRepository.update(runCase.id, {
      classification: attribution.verdict,
      confidence: Math.round(attribution.confidence * 100),
      evidenceJson: JSON.stringify({
        ...previousEvidence,
        evidence: pack,
        attribution,
        ...(usedLlm ? { llmUsed: true } : {}),
      }),
    });
    await eventRepository.append({
      runId: run.id,
      type: 'case.classified',
      payload: {
        runCaseId: runCase.id,
        classification: attribution.verdict,
        confidence: attribution.confidence,
        source: attribution.source,
      },
      now: clock(),
    });

    if (attribution.verdict === 'test_bug' && attribution.testRepairAllowed) {
      const repair = await createRepairSuggestion({
        repairRepository,
        caseRepository,
        runCase,
        attribution,
        readSuiteFile: options.readSuiteFile,
        ...(options.llm === undefined ? {} : { llm: options.llm }),
        pack,
        now: clock(),
      });

      if (repair.usage !== null) {
        usage.inputTokens += repair.usage.inputTokens;
        usage.outputTokens += repair.usage.outputTokens;
        usage.model = repair.usage.model;
      }
    }
  }

  // 保留 M5 已有统计（如并发/耗时），只更新归因摘要。
  const latest = (await runRepository.findById(run.id)) ?? active;
  const existingStats = parseObject(latest.statsJson);

  await runRepository.updateActive(
    run.id,
    {
      statsJson: JSON.stringify({
        ...existingStats,
        analysis: {
          analyzedAt: clock(),
          rule: summary.rule,
          llm: summary.llm,
          fallback: summary.fallback,
          llmInputTokens: usage.inputTokens,
          llmOutputTokens: usage.outputTokens,
        },
      }),
    },
    clock(),
  );
  await eventRepository.append({
    runId: run.id,
    type: 'run.analyzed',
    payload: {
      analyzed: summary.analyzed,
      llm: summary.llm,
      fallback: summary.fallback,
    },
    now: clock(),
  });

  return summary;
}

interface RepairSuggestionContext {
  repairRepository: RepairAttemptRepository;
  caseRepository: RunCaseRepository;
  runCase: RunCase;
  attribution: AttributionResult;
  readSuiteFile?: ((relativePath: string) => string | null) | undefined;
  llm?: LlmClient | null;
  pack: EvidencePack;
  now: number;
}

async function createRepairSuggestion(
  context: RepairSuggestionContext,
): Promise<{ usage: GenerationTokenUsage | null }> {
  const existing = await context.repairRepository.listByRunCase(context.runCase.id);

  if (existing.length >= 2) {
    return { usage: null };
  }

  const originalContent = context.readSuiteFile?.(context.runCase.featurePath) ?? '';
  const proposal = await proposeTestRepair({
    client: context.llm ?? null,
    pack: context.pack,
    attribution: context.attribution,
    originalContent,
    priorAttempts: existing.length,
  });
  const repairProposal = proposal.proposal;

  if (repairProposal !== null && repairProposal.patch !== null) {
    const reviewStatus: RepairReviewStatus =
      repairProposal.guard.status === 'allowed'
        ? 'not_required'
        : repairProposal.guard.status === 'blocked'
          ? 'rejected'
          : 'pending';

    try {
      await context.repairRepository.create({
        runCaseId: context.runCase.id,
        attemptNo: existing.length + 1,
        originalContent,
        patchedContent: repairProposal.patch.patchedContent,
        patchDiff: simplePatchDiff(
          originalContent,
          repairProposal.patch.patchedContent,
          context.runCase.featurePath,
        ),
        repairClass: repairProposal.repairClass,
        rationale: repairProposal.rationale,
        evidence: {
          verdict: context.attribution.verdict,
          confidence: context.attribution.confidence,
          evidenceRefs: repairProposal.evidenceRefs,
          codeLocations: context.pack.codeLocations,
        },
        model: repairProposal.model,
        guardStatus: repairProposal.guard.status,
        guardFindings: repairProposal.guard.findings,
        reviewStatus,
        featurePath: context.runCase.featurePath,
        now: context.now,
      });
      await context.caseRepository.update(context.runCase.id, {
        repairStatus: repairProposal.guard.status,
      });
    } catch {
      // 并发归因或重复建议时忽略唯一键冲突。
    }

    return { usage: proposal.usage };
  }

  const rationale = context.attribution.suggestedFix ?? '修复建议待人工确认';
  const guard = suggestionOnlyGuard(rationale);

  try {
    await context.repairRepository.create({
      runCaseId: context.runCase.id,
      attemptNo: existing.length + 1,
      originalContent,
      repairClass: 'test_update',
      rationale,
      evidence: {
        verdict: context.attribution.verdict,
        confidence: context.attribution.confidence,
        evidenceRefs: context.attribution.evidenceRefs,
        codeLocations: [],
      },
      guardStatus: guard.status,
      guardFindings: guard.findings,
      reviewStatus: 'pending',
      featurePath: context.runCase.featurePath,
      now: context.now,
    });
    await context.caseRepository.update(context.runCase.id, {
      repairStatus: guard.status,
    });
  } catch {
    // 并发重入或重复归因时忽略重复建议。
  }

  return { usage: proposal.usage };
}

export function classificationOf(value: string): Classification | null {
  return value === 'code_bug' ||
    value === 'test_bug' ||
    value === 'env_issue' ||
    value === 'flaky' ||
    value === 'unknown'
    ? value
    : null;
}
