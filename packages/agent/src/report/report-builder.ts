// 本文件所有改动要求遵循 agent-rules 规范
import {
  ArtifactRepository,
  EnvironmentRepository,
  NotificationRepository,
  ProjectRepository,
  RepairAttemptRepository,
  RunCaseRepository,
  RunRepository,
  TenantRepository,
} from '@gait/db';
import type { AppDatabase, RunCase } from '@gait/db';
import { CLASSIFICATIONS, emptyClassificationCounts } from '@gait/shared';
import type {
  AttributionResult,
  Classification,
  EvidencePack,
  ReportDistribution,
  ReportFailure,
  ReportRepair,
  RunReport,
} from '@gait/shared';

export interface BuildRunReportOptions {
  db: AppDatabase;
  tenantId: string;
  runId: string;
  baseUrl: string;
  now?: () => number;
  trendWindow?: number;
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

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function attributionOf(runCase: RunCase): AttributionResult | null {
  const raw = asObject(parseObject(runCase.evidenceJson).attribution);

  if (typeof raw.verdict !== 'string') {
    return null;
  }

  const verdict = CLASSIFICATIONS.includes(raw.verdict as Classification)
    ? (raw.verdict as Classification)
    : null;

  if (verdict === null) {
    return null;
  }

  return {
    verdict,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    rootCause: typeof raw.rootCause === 'string' ? raw.rootCause : '',
    evidenceRefs: Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
      : [],
    suggestedFix: typeof raw.suggestedFix === 'string' ? raw.suggestedFix : null,
    testRepairAllowed: raw.testRepairAllowed === true,
    source:
      raw.source === 'rule' || raw.source === 'llm' || raw.source === 'rerun'
        ? raw.source
        : 'fallback',
    conflict: null,
  };
}

function evidenceOf(runCase: RunCase): EvidencePack | null {
  const raw = asObject(parseObject(runCase.evidenceJson).evidence);

  return typeof raw.version === 'number' ? (raw as unknown as EvidencePack) : null;
}

function urlJoin(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function distributionOf(cases: readonly RunCase[]): ReportDistribution {
  const distribution: ReportDistribution = {
    total: cases.length,
    passed: 0,
    failed: 0,
    error: 0,
    skipped: 0,
    quarantined: 0,
    flaky: 0,
    byClassification: emptyClassificationCounts(),
  };

  for (const runCase of cases) {
    if (runCase.status === 'passed') {
      distribution.passed += 1;
    } else if (runCase.status === 'failed') {
      distribution.failed += 1;
    } else if (runCase.status === 'error') {
      distribution.error += 1;
    } else if (runCase.status === 'skipped') {
      distribution.skipped += 1;
    } else if (runCase.status === 'quarantined') {
      distribution.quarantined += 1;
    }

    if (runCase.classification !== null) {
      distribution.byClassification[runCase.classification] += 1;

      if (runCase.classification === 'flaky') {
        distribution.flaky += 1;
      }
    }
  }

  return distribution;
}

/** 生成结构化报告；所有字段来自数据库，不调用 LLM。 */
export function buildRunReport(options: BuildRunReportOptions): RunReport {
  const clock = options.now ?? (() => Date.now());
  const runRepository = new RunRepository(options.db, options.tenantId);
  const run = runRepository.findById(options.runId);

  if (run === undefined) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  const project = new ProjectRepository(options.db, options.tenantId).findById(run.projectId);

  if (project === undefined) {
    throw new Error('Run project not found');
  }

  const tenant = new TenantRepository(options.db).findById(options.tenantId);
  const environment =
    run.environmentId === null
      ? undefined
      : new EnvironmentRepository(options.db, options.tenantId).findById(run.environmentId);
  const cases = new RunCaseRepository(options.db, options.tenantId).listByRun(run.id);
  const repairRepository = new RepairAttemptRepository(options.db, options.tenantId);
  const distribution = distributionOf(cases);
  const runUrl = urlJoin(
    options.baseUrl,
    `/t/${tenant?.slug ?? 'unknown'}/p/${project.slug}/runs/${run.id}`,
  );
  const stats = parseObject(run.statsJson);
  const failures: ReportFailure[] = [];
  const repairs: ReportRepair[] = [];

  for (const runCase of cases) {
    if (runCase.status !== 'failed' && runCase.status !== 'error') {
      continue;
    }

    const attribution = attributionOf(runCase);
    const evidence = evidenceOf(runCase);
    const rerunRaw = asObject(parseObject(runCase.evidenceJson).rerun);

    failures.push({
      runCaseId: runCase.id,
      caseKey: runCase.caseKey,
      scenarioName: runCase.scenarioName,
      featurePath: runCase.featurePath,
      layer: runCase.layer,
      status: runCase.status,
      classification: runCase.classification,
      confidence: runCase.confidence === null ? null : runCase.confidence / 100,
      rootCause: attribution?.rootCause ?? runCase.errorMessage,
      suggestedFix: attribution?.suggestedFix ?? null,
      testRepairAllowed: attribution?.testRepairAllowed ?? false,
      evidenceRefs: attribution?.evidenceRefs ?? [],
      codeLocations: evidence?.codeLocations ?? [],
      rerunPassed: rerunRaw.passed === true,
      repairStatus: runCase.repairStatus,
      errorMessage: runCase.errorMessage,
      repro: {
        environmentId: run.environmentId,
        caseKey: runCase.caseKey,
        runUrl,
      },
    });

    for (const attempt of repairRepository.listByRunCase(runCase.id)) {
      repairs.push({
        runCaseId: runCase.id,
        attemptNo: attempt.attemptNo,
        repairClass: attempt.repairClass,
        rationale: attempt.rationale,
        guardStatus: attempt.guardStatus,
        appliedCommit: attempt.appliedCommit,
        createdAt: new Date(attempt.createdAt).toISOString(),
      });
    }
  }

  const notifications = new NotificationRepository(options.db, options.tenantId)
    .listByRun(run.id)
    .map((notification) => ({
      channelId: notification.channelId,
      eventType: notification.eventType,
      status: notification.status,
      attempts: notification.attempts,
      responseStatus: notification.responseStatus,
      sentAt: iso(notification.sentAt),
    }));
  const artifacts = new ArtifactRepository(options.db, options.tenantId)
    .listByRun(run.id)
    .map((artifact) => ({ type: artifact.type, path: artifact.path, mime: artifact.mime }));

  // 近 N 次趋势；只统计已有统计数据的 Run。
  const window = Math.max(2, options.trendWindow ?? 10);
  const recent = runRepository.listByProject(project.id, window);
  const withStats = recent
    .map((item) => {
      const raw = parseObject(item.statsJson);
      const total = typeof raw.total === 'number' ? raw.total : 0;
      const passed = typeof raw.passed === 'number' ? raw.passed : 0;
      const flaky = typeof raw.flaky === 'number' ? raw.flaky : 0;
      const analysis =
        raw.analysis !== null && typeof raw.analysis === 'object'
          ? (raw.analysis as Record<string, unknown>)
          : {};

      return {
        total,
        passed,
        flaky,
        durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
        inputTokens: typeof analysis.llmInputTokens === 'number' ? analysis.llmInputTokens : 0,
        outputTokens: typeof analysis.llmOutputTokens === 'number' ? analysis.llmOutputTokens : 0,
      };
    })
    .filter((item) => item.total > 0);
  const totalCases = withStats.reduce((sum, item) => sum + item.total, 0);
  const totalPassed = withStats.reduce((sum, item) => sum + item.passed, 0);
  const totalFlaky = withStats.reduce((sum, item) => sum + item.flaky, 0);
  const trend =
    withStats.length === 0
      ? null
      : {
          window: withStats.length,
          passRate: totalCases === 0 ? 0 : totalPassed / totalCases,
          flakyRate: totalCases === 0 ? 0 : totalFlaky / totalCases,
          averageDurationMs:
            withStats.reduce((sum, item) => sum + item.durationMs, 0) / withStats.length,
          llmInputTokens: withStats.reduce((sum, item) => sum + item.inputTokens, 0),
          llmOutputTokens: withStats.reduce((sum, item) => sum + item.outputTokens, 0),
        };
  const baselineEnvironment =
    run.baselineEnvironmentId === null
      ? undefined
      : new EnvironmentRepository(options.db, options.tenantId).findById(run.baselineEnvironmentId);
  const baselineRuns =
    run.baselineEnvironmentId === null
      ? []
      : runRepository
          .listByProject(project.id, 20)
          .filter((candidate) => candidate.environmentId === run.baselineEnvironmentId)
          .slice(0, 10);
  const baselineCases = baselineRuns.flatMap((candidate) =>
    new RunCaseRepository(options.db, options.tenantId).listByRun(candidate.id),
  );
  const baselinePassed = baselineCases.filter((item) => item.status === 'passed').length;
  const baselineFailed = baselineCases.filter(
    (item) => item.status === 'failed' || item.status === 'error',
  ).length;
  const baselineFlaky = baselineCases.filter((item) => item.classification === 'flaky').length;
  const baseline =
    run.baselineEnvironmentId === null
      ? null
      : {
          environmentId: run.baselineEnvironmentId,
          environmentName: baselineEnvironment?.name ?? null,
          historyRuns: baselineRuns.length,
          passed: baselinePassed,
          failed: baselineFailed,
          flaky: baselineFlaky,
          summary:
            baselineCases.length === 0
              ? '基线环境暂无历史用例结果，无法进行 A/B 对比。'
              : `基线环境最近 ${baselineRuns.length} 次 Run：通过 ${baselinePassed}，失败 ${baselineFailed}，flaky ${baselineFlaky}。`,
        };
  const startedAt = run.startedAt;
  const durationMs =
    typeof stats.durationMs === 'number'
      ? stats.durationMs
      : startedAt === null
        ? 0
        : Math.max(0, (run.finishedAt ?? clock()) - startedAt);

  return {
    version: 1,
    generatedAt: new Date(clock()).toISOString(),
    overview: {
      runId: run.id,
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      tenantSlug: tenant?.slug ?? 'unknown',
      branch: run.branch,
      baseSha: run.baseSha,
      headSha: run.headSha,
      deployedSha: run.deployedSha,
      versionMatch: run.versionMatch,
      environmentId: run.environmentId,
      environmentName: environment?.name ?? null,
      baselineEnvironmentId: run.baselineEnvironmentId,
      trigger: run.trigger,
      status: run.status,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      durationMs,
      passRate: distribution.total === 0 ? 0 : distribution.passed / distribution.total,
      runUrl,
    },
    distribution,
    failures,
    repairs,
    trend,
    baseline,
    notifications,
    attachments: artifacts,
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  const seconds = Math.round(ms / 1_000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const CLASSIFICATION_LABELS: Readonly<Record<Classification, string>> = {
  code_bug: '代码缺陷',
  test_bug: '用例问题',
  env_issue: '环境问题',
  flaky: '偶发失败',
  unknown: '待确认',
};

export function renderReportMarkdown(report: RunReport): string {
  const lines: string[] = [
    `# 测试报告：${report.overview.projectName} / ${report.overview.branch ?? 'unknown'}`,
    '',
    `- **Run**：${report.overview.runId}`,
    `- **目标 commit**：\`${report.overview.headSha}\``,
    `- **部署版本**：\`${report.overview.deployedSha ?? 'unknown'}\`（${report.overview.versionMatch === false ? '不一致' : '一致或未校验'}）`,
    `- **环境**：${report.overview.environmentName ?? '未配置'}`,
    `- **状态**：${report.overview.status}`,
    `- **通过率**：${(report.overview.passRate * 100).toFixed(1)}%（${report.distribution.passed}/${report.distribution.total}）`,
    `- **耗时**：${formatDuration(report.overview.durationMs)}`,
    `- **触发方式**：${report.overview.trigger}`,
    '',
    '## 结果分布',
    '',
    '| 状态 | 数量 |',
    '|---|---:|',
    `| 通过 | ${report.distribution.passed} |`,
    `| 失败 | ${report.distribution.failed} |`,
    `| 错误 | ${report.distribution.error} |`,
    `| 跳过 | ${report.distribution.skipped} |`,
    `| 隔离 | ${report.distribution.quarantined} |`,
    `| 偶发 | ${report.distribution.flaky} |`,
    '',
    '### 归因分布',
    '',
    '| 分类 | 数量 |',
    '|---|---:|',
    ...CLASSIFICATIONS.map(
      (classification) =>
        `| ${CLASSIFICATION_LABELS[classification]}（${classification}） | ${report.distribution.byClassification[classification]} |`,
    ),
    '',
  ];

  if (report.failures.length > 0) {
    lines.push('## 失败明细', '');

    for (const failure of report.failures) {
      lines.push(
        `### ${escapeMarkdown(failure.scenarioName)}`,
        '',
        `- **文件**：\`${failure.featurePath}\``,
        `- **分类**：${failure.classification ?? '未归因'}${
          failure.confidence === null ? '' : `（置信度 ${(failure.confidence * 100).toFixed(0)}%）`
        }`,
        `- **根因**：${escapeMarkdown(failure.rootCause ?? '无')}`,
        `- **建议修复**：${escapeMarkdown(failure.suggestedFix ?? '无')}`,
        `- **重跑结果**：${failure.rerunPassed ? '通过（flaky）' : '仍失败'}`,
        `- **复现入口**：${failure.repro.runUrl}`,
      );

      if (failure.codeLocations.length > 0) {
        lines.push('- **代码候选**：');

        for (const location of failure.codeLocations) {
          lines.push(
            `  - \`${location.path}${location.line === null ? '' : `:${location.line}`}\` — ${escapeMarkdown(location.reason)}`,
          );
        }
      }

      if (failure.evidenceRefs.length > 0) {
        lines.push(`- **证据引用**：${failure.evidenceRefs.map((ref) => `\`${ref}\``).join('、')}`);
      }

      lines.push('');
    }
  }

  if (report.repairs.length > 0) {
    lines.push('## 修复建议', '');

    for (const repair of report.repairs) {
      lines.push(
        `- 用例 \`${repair.runCaseId}\` 第 ${repair.attemptNo} 次：${repair.repairClass}，guard=${repair.guardStatus}，${escapeMarkdown(repair.rationale)}`,
      );
    }

    lines.push('');
  }

  if (report.notifications.length > 0) {
    lines.push('## 通知记录', '');

    for (const notification of report.notifications) {
      lines.push(
        `- ${notification.eventType}：${notification.status}，尝试 ${notification.attempts} 次`,
      );
    }

    lines.push('');
  }

  if (report.attachments.length > 0) {
    lines.push('## 附件', '');

    for (const attachment of report.attachments) {
      lines.push(`- ${attachment.type}：\`${attachment.path}\`（${attachment.mime}）`);
    }

    lines.push('');
  }

  lines.push(
    '## 趋势',
    '',
    report.trend === null
      ? '暂无历史基线数据。'
      : `近 ${report.trend.window} 次：通过率 ${(report.trend.passRate * 100).toFixed(1)}%，flaky 率 ${(report.trend.flakyRate * 100).toFixed(1)}%，平均耗时 ${formatDuration(Math.round(report.trend.averageDurationMs))}。`,
    '',
    '## 基线环境对比',
    '',
    report.baseline === null
      ? '未配置基线环境。'
      : `${escapeMarkdown(report.baseline.summary)}（环境：${escapeMarkdown(
          report.baseline.environmentName ?? report.baseline.environmentId,
        )}）`,
    '',
    '> 本报告由平台基于证据自动生成；代码位置仅为候选，不自动修改产品代码。',
    '',
  );

  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

export function renderReportHtml(report: RunReport): string {
  const rows = report.failures
    .map(
      (failure) => `<tr>
<td>${escapeHtml(failure.scenarioName)}</td>
<td><code>${escapeHtml(failure.featurePath)}</code></td>
<td>${escapeHtml(failure.classification ?? 'unknown')}</td>
<td>${failure.confidence === null ? '-' : `${Math.round(failure.confidence * 100)}%`}</td>
<td>${escapeHtml(failure.rootCause ?? '')}</td>
<td><a href="${escapeHtml(failure.repro.runUrl)}">复现</a></td>
</tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>测试报告 ${escapeHtml(report.overview.projectName)} - ${escapeHtml(report.overview.runId)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f8fa;color:#1f2328;margin:0;padding:24px}
main{max-width:1100px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:24px}
code{font-family:ui-monospace,SFMono-Regular,monospace}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #d0d7de;padding:8px;text-align:left;font-size:14px}
th{background:#f6f8fa}
.bad{color:#cf222e;font-weight:600}
</style>
</head>
<body>
<main>
<h1>测试报告：${escapeHtml(report.overview.projectName)} / ${escapeHtml(report.overview.branch ?? 'unknown')}</h1>
<p>Run <code>${escapeHtml(report.overview.runId)}</code> · 目标 commit <code>${escapeHtml(report.overview.headSha)}</code> · 部署版本 <code>${escapeHtml(report.overview.deployedSha ?? 'unknown')}</code></p>
<p>状态 <strong>${escapeHtml(report.overview.status)}</strong> · 通过率 <strong>${(report.overview.passRate * 100).toFixed(1)}%</strong> (${report.distribution.passed}/${report.distribution.total}) · 耗时 ${escapeHtml(formatDuration(report.overview.durationMs))}</p>
<h2>结果分布</h2>
<table><tbody>
<tr><th>通过</th><td>${report.distribution.passed}</td><th>失败</th><td class="bad">${report.distribution.failed}</td><th>错误</th><td class="bad">${report.distribution.error}</td></tr>
<tr><th>跳过</th><td>${report.distribution.skipped}</td><th>隔离</th><td>${report.distribution.quarantined}</td><th>偶发</th><td>${report.distribution.flaky}</td></tr>
</tbody></table>
<h2>失败明细</h2>
<table>
<thead><tr><th>场景</th><th>文件</th><th>分类</th><th>置信度</th><th>根因</th><th>复现</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">无失败用例</td></tr>'}</tbody>
</table>
<p><small>代码位置仅为候选，平台不会自动修改产品代码。</small></p>
</main>
</body>
</html>`;
}

export function renderReportJUnit(report: RunReport): string {
  const totalSeconds = (report.overview.durationMs / 1_000).toFixed(3);
  const errorCount = report.failures.filter((failure) => failure.status === 'error').length;
  const failureCount = report.failures.length - errorCount;
  const cases = report.failures
    .map((failure) => {
      const message = failure.errorMessage ?? failure.rootCause ?? 'Failed';
      const body = [
        failure.rootCause ?? '',
        failure.suggestedFix === null ? '' : `建议：${failure.suggestedFix}`,
        failure.codeLocations
          .map(
            (location) =>
              `${location.path}${location.line === null ? '' : `:${location.line}`} ${location.reason}`,
          )
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n');

      return `<testcase classname="${escapeXml(failure.featurePath)}" name="${escapeXml(
        failure.scenarioName,
      )}" time="0"><failure type="${escapeXml(
        failure.classification ?? 'unknown',
      )}" message="${escapeXml(message.slice(0, 500))}">${escapeXml(body)}</failure></testcase>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${escapeXml(report.overview.projectName)}" tests="${report.failures.length}" failures="${failureCount}" errors="${errorCount}" skipped="0" time="${totalSeconds}">
<testsuite name="${escapeXml(report.overview.branch ?? 'run')}" tests="${report.failures.length}" failures="${failureCount}" errors="${errorCount}" skipped="0" time="${totalSeconds}">
${cases}
</testsuite>
</testsuites>`;
}

export { CLASSIFICATION_LABELS, formatDuration };
