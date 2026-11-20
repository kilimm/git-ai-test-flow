// 本文件所有改动要求遵循 agent-rules 规范
import { createHmac } from 'node:crypto';

const MAX_MESSAGE_LENGTH = 300;

/**
 * 飞书自定义机器人签名：
 * key = `${timestamp}\n${secret}`，data 为空串，结果 base64。
 */
export function createFeishuSignature(timestampSeconds: number, secret: string): string {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

export interface FeishuTestCardInput {
  projectName: string;
  channelName: string;
  triggeredAt: number;
}

/** 测试卡片只包含非敏感信息，用于验证 Webhook 与签名。 */
export function buildFeishuTestCard(input: FeishuTestCardInput): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'git-ai-test-flow 通知测试' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `项目：${input.projectName}`,
            `渠道：${input.channelName}`,
            `时间：${new Date(input.triggeredAt).toISOString()}`,
            '',
            '收到此卡片说明 Webhook 与签名配置可用。',
          ].join('\n'),
        },
      },
    ],
  };
}

export interface FeishuSendResult {
  ok: boolean;
  code: string;
  message: string;
}

function truncate(message: string): string {
  const trimmed = message.trim();

  return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…` : trimmed;
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
      message: truncate(message.length > 0 ? message : `Feishu returned HTTP ${httpStatus}`),
    };
  }

  if (
    (numericCode !== undefined && numericCode !== 0) ||
    (statusCode !== undefined && statusCode !== 0)
  ) {
    return {
      ok: false,
      code: 'FEISHU_API_ERROR',
      message: truncate(message.length > 0 ? message : 'Feishu rejected the message'),
    };
  }

  return { ok: true, code: 'OK', message: 'Test card sent' };
}
