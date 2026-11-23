// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  ArtifactRepository,
  EnvironmentRepository,
  ProjectRepository,
  RunCaseRepository,
  RunRepository,
  StepResultRepository,
} from '@gait/db';
import type { AppDatabase, Artifact, Run, StepResult } from '@gait/db';
import { collectRangeDiff } from '@gait/git';
import {
  ANALYSIS_LIMITS,
  EVIDENCE_PACK_VERSION,
  type DiffFile,
  type EvidenceArtifact,
  type EvidenceCase,
  type EvidenceCodeLocation,
  type EvidenceDiffFile,
  type EvidenceLog,
  type EvidencePack,
  type EvidenceRerun,
  type EvidenceSignals,
  type EvidenceStep,
  type Classification,
} from '@gait/shared';
import { redactJson, redactText } from '@gait/runner';

export interface BuildEvidenceOptions {
  db: AppDatabase;
  tenantId: string;
  runId: string;
  runCaseId: string;
  dataDir: string;
  /**
   * 已采集的 diff。传 `null` 表示明确不查询 Git；
   * 缺省时从产品 mirror 计算 base..head 差异。
   */
  diff?: DiffFile[] | null;
  now?: () => number;
  readSuiteFile?: (relativePath: string) => string | null;
  readFile?: (absolutePath: string) => string;
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

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

function errorOf(json: string | null): { code: string; message: string } | null {
  if (json === null) {
    return null;
  }

  const raw = parseObject(json);
  const code = typeof raw.code === 'string' ? raw.code : 'STEP_FAILED';
  const message = typeof raw.message === 'string' ? redactText(raw.message) : '';

  return { code, message: truncate(message, 1_000) };
}

function stepEvidence(step: StepResult): EvidenceStep {
  return {
    index: step.stepIndex,
    keyword: step.keyword,
    text: redactText(step.text),
    type: step.type,
    status: step.status,
    durationMs: step.durationMs,
    error: errorOf(step.errorJson),
    output: redactJson(parseObject(step.outputJson)),
  };
}

function artifactEvidence(artifact: Artifact): EvidenceArtifact {
  return {
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    mime: artifact.mime,
    size: artifact.size,
    redacted: artifact.redacted,
  };
}

function extractEndpoints(text: string): string[] {
  const matches = text.match(/\/(?:api|rest|graphql|v\d+)\/[A-Za-z0-9_\-/{}.$:]+/g) ?? [];

  return [...new Set(matches.map((match) => match.replace(/[.,;:]+$/, '')))]
    .filter((match) => match.length > 2)
    .slice(0, 10);
}

function extractSelectors(text: string): string[] {
  const matches = text.match(/"([^"\n]{2,80})"|'([^'\n]{2,80})'/g) ?? [];
  const selectors = matches
    .map((match) => match.slice(1, -1).trim())
    .filter((match) => match.length >= 2 && !match.includes('{{') && !/^\s*$/.test(match));

  return [...new Set(selectors)].slice(0, 10);
}

function hunkLine(header: string): number | null {
  const match = /\+(\d+)/.exec(header);

  return match === null ? null : Number(match[1]);
}

function diffEvidence(file: DiffFile): EvidenceDiffFile {
  return {
    path: file.path,
    status: file.status,
    category: file.category,
    hunks: file.hunks.slice(0, 10).map((hunk) => ({
      header: hunk.header,
      content: truncate(redactText(hunk.content), ANALYSIS_LIMITS.MAX_HUNK_CHARS),
    })),
  };
}

interface SignalContext {
  failedStep: EvidenceStep | null;
  diffFiles: EvidenceDiffFile[];
}

function computeSignals(context: SignalContext, featureRoot: string): EvidenceSignals {
  const failedStep = context.failedStep;
  const text = failedStep?.text ?? '';
  const endpoints = extractEndpoints(text);
  const selectors =
    failedStep?.type === 'ui' || failedStep?.type === 'agent' ? extractSelectors(text) : [];
  const addedSelectors = selectors.some((selector) =>
    context.diffFiles.some(
      (file) =>
        file.category === 'frontend' &&
        file.hunks.some((hunk) =>
          hunk.content.split('\n').some((line) => line.startsWith('-') && line.includes(selector)),
        ),
    ),
  );
  const testFilesChanged = context.diffFiles.some(
    (file) =>
      file.path.endsWith('.feature') ||
      file.path === featureRoot ||
      file.path.startsWith(`${featureRoot.replace(/\/+$/, '')}/`),
  );

  return {
    failedStepType: failedStep?.type ?? null,
    failedStepKeyword: failedStep?.keyword ?? null,
    failedStepText: failedStep === null ? null : truncate(redactText(text), 1_000),
    endpoints,
    selectors,
    selectorChanged: addedSelectors,
    testFilesChanged,
    productFilesChanged: context.diffFiles.length > 0,
    codeTouchConfidence: 0,
  };
}

/**
 * 从失败步骤与 diff 中生成代码文件/行候选。
 * 只给「候选」，不把猜测写成确定结论。
 */
export function locateCode(
  failedStep: EvidenceStep | null,
  diffFiles: readonly EvidenceDiffFile[],
): EvidenceCodeLocation[] {
  if (failedStep === null) {
    return [];
  }

  const text = `${failedStep.text}\n${failedStep.error?.message ?? ''}`;
  const endpoints = extractEndpoints(text);
  const words = [...new Set(text.match(/[A-Za-z][A-Za-z0-9_]{4,}/g) ?? [])]
    .filter(
      (word) =>
        !['expect', 'should', 'status', 'response', 'request', 'timeout'].includes(
          word.toLowerCase(),
        ),
    )
    .slice(0, 30);
  const locations: EvidenceCodeLocation[] = [];

  for (const file of diffFiles) {
    let reason: string | null = null;
    let confidence = 0;
    let line: number | null = null;

    for (const endpoint of endpoints) {
      const segment = endpoint.split('/').filter(Boolean).pop() ?? '';
      const hunkHit = file.hunks.find((hunk) => hunk.content.includes(endpoint));
      const pathHit =
        segment.length >= 3 && file.path.toLowerCase().includes(segment.toLowerCase());

      if (hunkHit !== undefined || pathHit) {
        reason = `失败步骤涉及 ${endpoint}，与本次变更文件 ${file.path} 相关`;
        confidence = hunkHit === undefined ? 0.55 : 0.7;
        line = hunkHit === undefined ? null : hunkLine(hunkHit.header);
        break;
      }
    }

    if (reason === null) {
      const word = words.find((candidate) =>
        file.hunks.some((hunk) => hunk.content.includes(candidate)),
      );

      if (word !== undefined) {
        const hunk = file.hunks.find((item) => item.content.includes(word));
        reason = `失败信息中的标识符「${word}」出现在变更 hunk 中`;
        confidence = 0.4;
        line = hunk === undefined ? null : hunkLine(hunk.header);
      }
    }

    if (reason !== null) {
      locations.push({ path: file.path, line, reason, confidence });
    }
  }

  return locations.sort((left, right) => right.confidence - left.confidence).slice(0, 5);
}

function readLogTail(options: BuildEvidenceOptions, artifact: Artifact): EvidenceLog | null {
  if (artifact.type !== 'console' && artifact.type !== 'log') {
    return null;
  }

  const absolute = join(options.dataDir, artifact.path);
  const root = join(options.dataDir);

  if (
    relative(root, absolute).startsWith(`..${sep}`) ||
    relative(root, absolute) === '..' ||
    !existsSync(absolute)
  ) {
    return null;
  }

  try {
    const reader = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const content = reader(absolute);
    const tail = content.length > 4_000 ? content.slice(-4_000) : content;

    return {
      source: artifact.type,
      artifactId: artifact.id,
      tail: truncate(redactText(tail), 4_000),
    };
  } catch {
    return null;
  }
}

async function collectDiff(options: BuildEvidenceOptions, run: Run): Promise<DiffFile[] | null> {
  if (options.diff !== undefined) {
    return options.diff;
  }

  if (run.baseSha === null) {
    return null;
  }

  const mirrorPath = join(options.dataDir, 'git', 'mirrors', `product-${run.projectId}.git`);

  if (!existsSync(mirrorPath)) {
    return null;
  }

  try {
    const result = await collectRangeDiff({
      repoPath: mirrorPath,
      baseSha: run.baseSha,
      headSha: run.headSha,
      maxFiles: 100,
    });

    return result.files;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function classifyRerun(evidenceJson: string): EvidenceRerun | null {
  const rerun = asObject(parseObject(evidenceJson).rerun);

  if (typeof rerun.attempted !== 'boolean') {
    return null;
  }

  return {
    attempted: rerun.attempted,
    previousStatus: typeof rerun.previousStatus === 'string' ? rerun.previousStatus : 'failed',
    previousErrorCode: typeof rerun.previousErrorCode === 'string' ? rerun.previousErrorCode : null,
    passed: rerun.passed === true,
    durationMs: typeof rerun.durationMs === 'number' ? rerun.durationMs : 0,
  };
}

/**
 * 构建单用例证据包：
 * - 步骤、错误、输出、产物元数据来自数据库；
 * - 日志读取产物并脱敏截断；
 * - diff 来自产品 mirror（只读）；
 * - 历史结果只取同项目同场景，默认 10 条。
 */
export async function buildCaseEvidence(options: BuildEvidenceOptions): Promise<EvidencePack> {
  const runs = new RunRepository(options.db, options.tenantId);
  const cases = new RunCaseRepository(options.db, options.tenantId);
  const stepsRepository = new StepResultRepository(options.db, options.tenantId);
  const artifactsRepository = new ArtifactRepository(options.db, options.tenantId);
  const run = await runs.findById(options.runId);
  const runCase = await cases.findById(options.runCaseId);

  if (run === undefined || runCase === undefined || runCase.runId !== run.id) {
    throw new Error('Run case evidence target not found');
  }

  const project = await new ProjectRepository(options.db, options.tenantId).findById(run.projectId);
  const environment =
    run.environmentId === null
      ? undefined
      : await new EnvironmentRepository(options.db, options.tenantId).findById(run.environmentId);
  const steps = (await stepsRepository.listByRunCase(runCase.id)).map(stepEvidence);
  const failedStep =
    steps.find((step) => step.status === 'failed' || step.status === 'error') ?? null;
  const artifacts = await artifactsRepository.listByRunCase(runCase.id);
  const rawDiff = await collectDiff(options, run);
  const diffFiles = (rawDiff ?? [])
    .filter((file) => !file.binary && !file.skipped)
    .slice(0, ANALYSIS_LIMITS.MAX_DIFF_FILES)
    .map(diffEvidence);
  const signals = computeSignals({ failedStep, diffFiles }, project?.featureRoot ?? 'features');
  const codeLocations = locateCode(failedStep, diffFiles);

  signals.codeTouchConfidence =
    codeLocations.length === 0 ? 0 : Math.max(...codeLocations.map((item) => item.confidence));

  const history = (
    await cases.listHistory({
      projectId: run.projectId,
      featurePath: runCase.featurePath,
      scenarioName: runCase.scenarioName,
      caseKey: runCase.caseKey,
      excludeRunId: run.id,
      limit: ANALYSIS_LIMITS.MAX_HISTORY_RUNS,
    })
  ).map((entry) => ({
    runId: entry.runId,
    headSha: entry.headSha,
    status: entry.runStatus,
    caseStatus: entry.caseStatus,
    classification: entry.classification as Classification | null,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  }));

  const featureSource = options.readSuiteFile?.(runCase.featurePath) ?? null;
  const evidenceCase: EvidenceCase = {
    id: runCase.id,
    featurePath: runCase.featurePath,
    scenarioName: runCase.scenarioName,
    line: runCase.line,
    caseKey: runCase.caseKey,
    tags: parseArray<string>(runCase.tagsJson),
    layer: runCase.layer,
    status: runCase.status,
    attempt: runCase.attempt,
    errorMessage: runCase.errorMessage === null ? null : redactText(runCase.errorMessage),
    featureSource:
      featureSource === null
        ? null
        : truncate(redactText(featureSource), ANALYSIS_LIMITS.MAX_HUNK_CHARS * 4),
  };
  const logs = artifacts
    .map((artifact) => readLogTail(options, artifact))
    .filter((log): log is EvidenceLog => log !== null)
    .slice(0, 3);

  return {
    version: EVIDENCE_PACK_VERSION,
    collectedAt: (options.now ?? (() => Date.now()))(),
    run: {
      id: run.id,
      projectId: run.projectId,
      branch: run.branch,
      baseSha: run.baseSha,
      headSha: run.headSha,
      deployedSha: run.deployedSha,
      versionMatch: run.versionMatch,
      status: run.status,
      trigger: run.trigger,
    },
    environment: {
      id: run.environmentId,
      name: environment?.name ?? null,
      apiBaseUrl: environment?.apiBaseUrl ?? null,
      versionMatch: run.versionMatch,
      deployedSha: run.deployedSha,
      healthy:
        environment === undefined || environment === null
          ? null
          : environment.healthStatus === 'healthy',
    },
    case: evidenceCase,
    failedStepIndex: failedStep?.index ?? null,
    steps,
    artifacts: artifacts.map(artifactEvidence),
    logs,
    signals,
    history,
    diff: {
      available: rawDiff !== null,
      files: diffFiles,
      testFilesChanged: signals.testFilesChanged,
      truncated: (rawDiff?.length ?? 0) > ANALYSIS_LIMITS.MAX_DIFF_FILES,
    },
    codeLocations,
    rerun: classifyRerun(runCase.evidenceJson),
    redacted: true,
  };
}

/** LLM 与归因结果可引用的证据 ID 列表。 */
export function evidenceRefs(pack: EvidencePack): string[] {
  const refs = [
    'environment',
    ...pack.steps.map((step) => `step:${step.index}`),
    ...pack.steps
      .filter((step) => step.error !== null)
      .map((step) => `error:${step.error?.code ?? 'STEP_FAILED'}`),
    ...pack.diff.files.map((file) => `diff:${file.path}`),
    ...pack.codeLocations.map(
      (location) => `diff:${location.path}${location.line === null ? '' : `:${location.line}`}`,
    ),
    ...pack.history.map((entry) => `history:${entry.runId}`),
    ...pack.artifacts.map((artifact) => `artifact:${artifact.id}`),
  ];

  if (pack.rerun !== null) {
    refs.push('rerun');
  }

  return [...new Set(refs)];
}
