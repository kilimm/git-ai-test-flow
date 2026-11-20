// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';
import { CLASSIFICATIONS, ANALYSIS_LIMITS } from '@gait/shared';
import type { AttributionResult, EvidencePack, GenerationTokenUsage } from '@gait/shared';
import { generateStructured, StructuredOutputError } from '../llm/llm-client.js';
import type { LlmClient } from '../llm/llm-client.js';
import { evidenceRefs } from './evidence.js';

export const LLM_ATTRIBUTION_SYSTEM = [
  '你是测试失败归因分析器。',
  '只能依据提供的证据包下结论，禁止编造文件、行号、接口或日志。',
  'verdict 必须是 code_bug / test_bug / env_issue / flaky / unknown 之一。',
  'code_bug 表示产品代码缺陷；test_bug 表示用例过期或断言错误；',
  'env_issue 表示环境/数据准备问题；flaky 表示偶发失败；证据不足必须输出 unknown。',
  'evidence_refs 至少引用一个证据 ID，且只能从 allowed_evidence_refs 中选择。',
  'confidence 为 0-1；证据不足时不得给出高置信度。',
  'code_bug 时 test_repair_allowed 必须为 false，禁止建议修改测试迁就缺陷。',
  '只输出 JSON，不要输出 Markdown 或解释文字。',
].join('\n');

export const LlmAttributionSchema = z.object({
  verdict: z.enum(CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  root_cause: z.string().min(1).max(2_000),
  evidence_refs: z.array(z.string().min(1)).min(1).max(20),
  suggested_fix: z.string().max(4_000).nullable().optional(),
  test_repair_allowed: z.boolean().optional(),
});

export type LlmAttributionOutput = z.infer<typeof LlmAttributionSchema>;

export interface LlmAttributionOptions {
  client: LlmClient;
  pack: EvidencePack;
  rule: AttributionResult;
  allowedRefs?: string[];
}

export interface LlmAttributionResult {
  attribution: AttributionResult;
  usage: GenerationTokenUsage;
}

export function buildAttributionPrompt(
  pack: EvidencePack,
  rule: AttributionResult,
  allowedRefs: readonly string[],
): string {
  const compact = {
    ...pack,
    steps: pack.steps.slice(-ANALYSIS_LIMITS.MAX_EVIDENCE_STEPS),
    logs: pack.logs.map((log) => ({ ...log, tail: log.tail.slice(-2_000) })),
  };

  return [
    '请基于证据包分析失败原因。',
    '',
    '规则引擎初判（仅供参考，可以有依据地推翻）：',
    JSON.stringify(
      {
        verdict: rule.verdict,
        confidence: rule.confidence,
        root_cause: rule.rootCause,
      },
      null,
      2,
    ),
    '',
    `allowed_evidence_refs：${allowedRefs.join(', ')}`,
    '',
    '证据包：',
    JSON.stringify(compact, null, 2),
    '',
    '输出字段：verdict, confidence, root_cause, evidence_refs, suggested_fix, test_repair_allowed。',
  ].join('\n');
}

function unknownFromLlm(rootCause: string, confidence = 0.35): AttributionResult {
  return {
    verdict: 'unknown',
    confidence,
    rootCause,
    evidenceRefs: [],
    suggestedFix: null,
    testRepairAllowed: false,
    source: 'llm',
    conflict: null,
  };
}

/**
 * LLM 归因输出必须通过 Zod 校验与证据引用校验；
 * 调用失败或输出非法时返回 null，由规则结论兜底。
 */
export async function attributeWithLlm(
  options: LlmAttributionOptions,
): Promise<LlmAttributionResult | null> {
  const allowed = options.allowedRefs ?? evidenceRefs(options.pack);

  try {
    const response = await generateStructured(options.client, LlmAttributionSchema, {
      system: LLM_ATTRIBUTION_SYSTEM,
      user: buildAttributionPrompt(options.pack, options.rule, allowed),
      temperature: 0.1,
      maxTokens: 2_048,
    });
    const output = response.value;
    const refs = [...new Set(output.evidence_refs)].filter((ref) => allowed.includes(ref));

    if (refs.length === 0) {
      return {
        attribution: unknownFromLlm('LLM 输出未引用有效证据，回退为 unknown', 0.35),
        usage: response.usages[response.usages.length - 1] ?? {
          inputTokens: 0,
          outputTokens: 0,
          model: 'unknown',
        },
      };
    }

    let verdict = output.verdict;
    const confidence = output.confidence;
    let rootCause = output.root_cause;
    const lowConfidence = confidence < ANALYSIS_LIMITS.LLM_MIN_CONFIDENCE;

    if (lowConfidence) {
      verdict = 'unknown';
      rootCause = `LLM 置信度不足（${confidence.toFixed(2)}）：${output.root_cause}`;
    }

    const attribution: AttributionResult = {
      verdict,
      confidence,
      rootCause,
      evidenceRefs: refs,
      suggestedFix: output.suggested_fix ?? null,
      testRepairAllowed:
        verdict === 'test_bug' &&
        output.test_repair_allowed === true &&
        !lowConfidence &&
        confidence >= 0.7,
      source: 'llm',
      conflict: null,
    };

    return {
      attribution,
      usage: response.usages[response.usages.length - 1] ?? {
        inputTokens: 0,
        outputTokens: 0,
        model: 'unknown',
      },
    };
  } catch (error) {
    if (error instanceof StructuredOutputError) {
      return null;
    }

    return null;
  }
}

/**
 * 规则与 LLM 合并策略：
 * - 环境/重跑/flaky 等强规则不被低置信 LLM 覆盖；
 * - 规则为 unknown 或置信度低时优先采用有证据的 LLM 结论；
 * - 冲突时保留置信度更高者，并在结果中记录冲突供报告标注。
 */
export function combineAttributions(
  rule: AttributionResult,
  llm: AttributionResult | null,
): AttributionResult {
  if (llm === null) {
    return rule;
  }

  const ruleStrong =
    rule.confidence >= ANALYSIS_LIMITS.RULE_OVERRIDE_THRESHOLD ||
    rule.verdict === 'env_issue' ||
    rule.verdict === 'flaky';

  const chosen = !ruleStrong && llm.confidence >= ANALYSIS_LIMITS.LLM_MIN_CONFIDENCE ? llm : rule;
  const other = chosen === rule ? llm : rule;

  return {
    ...chosen,
    conflict:
      chosen.verdict === other.verdict
        ? null
        : { otherVerdict: other.verdict, otherConfidence: other.confidence },
  };
}
