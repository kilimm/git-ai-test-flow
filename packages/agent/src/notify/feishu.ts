// 本文件所有改动要求遵循 agent-rules 规范
import { createHmac } from 'node:crypto';
import type { RunReport } from '@gait/shared';
import { formatDuration } from '../report/report-builder.js';

/** 飞书自定义机器人签名：key=`${timestamp}\n${secret}`，data 为空串。 */
export function createFeishuSignature(timestampSeconds: number, secret: string): string {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** 卡片正文只放摘要，详情通过深链回平台，避免超过 20 KB。 */
export function buildRunFeishuCard(report: RunReport): Record<string, unknown> {
  const failed = report.overview.status === 'failed';
  const mainIssues = report.failures
    .slice(0, 3)
    .map(
      (failure) =>
        `- \`${failure.classification ?? 'unknown'}\` ${truncate(
          failure.rootCause ?? failure.scenarioName,
          160,
        )}`,
    )
    .join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      template: failed ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: `测试报告：${truncate(report.overview.projectName, 60)} / ${truncate(
          report.overview.branch ?? 'unknown',
          40,
        )}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**运行** \`${report.overview.runId}\` · commit \`${report.overview.headSha.slice(0, 10)}\``,
          `**通过率** ${(report.overview.passRate * 100).toFixed(1)}%（${report.distribution.passed}/${report.distribution.total}）`,
          `**失败** ${report.distribution.failed + report.distribution.error} · **环境** ${
            report.distribution.byClassification.env_issue
          } · **偶发** ${report.distribution.flaky}`,
          `**环境** ${report.overview.environmentName ?? '未配置'} · **耗时** ${formatDuration(
            report.overview.durationMs,
          )}`,
          report.overview.versionMatch === false ? '**⚠️ 部署版本与目标 commit 不一致**' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: mainIssues.length > 0 ? `**主要问题**\n${mainIssues}` : '没有失败用例。',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看详情' },
            type: 'primary',
            url: report.overview.runUrl,
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: 'git-ai-test-flow · 代码定位为候选，平台不自动修改产品代码',
          },
        ],
      },
    ],
  };
}

export interface FeishuSendResult {
  ok: boolean;
  code: string;
  message: string;
}

export function parseFeishuResponse(httpStatus: number, bodyText: string): FeishuSendResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'Feishu returned a non-JSON response' };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'Feishu returned an invalid response' };
  }

  const body = parsed as Record<string, unknown>;
  const numericCode = typeof body.code === 'number' ? body.code : undefined;
  const statusCode = typeof body.StatusCode === 'number' ? body.StatusCode : undefined;
  const message =
    typeof body.msg === 'string'
      ? body.msg
      : typeof body.StatusMessage === 'string'
        ? body.StatusMessage
        : '';

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      code: 'HTTP_ERROR',
      message: truncate(message.length > 0 ? message : `Feishu returned HTTP ${httpStatus}`, 300),
    };
  }

  if (
    (numericCode !== undefined && numericCode !== 0) ||
    (statusCode !== undefined && statusCode !== 0)
  ) {
    return {
      ok: false,
      code: 'FEISHU_API_ERROR',
      message: truncate(message.length > 0 ? message : 'Feishu rejected the message', 300),
    };
  }

  return { ok: true, code: 'OK', message: 'Notification sent' };
}
