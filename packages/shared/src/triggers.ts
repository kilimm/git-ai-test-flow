// 本文件所有改动要求遵循 agent-rules 规范
import type { RunSelection } from './run.js';

export const TRIGGER_TYPES = ['schedule', 'git_webhook', 'deployment'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const TRIGGER_ACTIONS = ['generate', 'run'] as const;
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number];

export interface TriggerConfigView {
  id: string;
  projectId: string;
  name: string;
  type: TriggerType;
  action: TriggerAction;
  enabled: boolean;
  cron: string | null;
  branch: string | null;
  environmentId: string | null;
  selection: RunSelection;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerCreateResult {
  trigger: TriggerConfigView;
  /** 仅创建/轮换时返回一次，之后只保存 SHA-256。 */
  token: string | null;
}

export const TRIGGER_TOKEN_PREFIX = 'gait_trg_';

/** 部署回调/Git Webhook 专用错误码。 */
export const WEBHOOK_ERROR = {
  TOKEN_INVALID: 'WEBHOOK_TOKEN_INVALID',
  PAYLOAD_INVALID: 'WEBHOOK_PAYLOAD_INVALID',
  TRIGGER_DISABLED: 'TRIGGER_DISABLED',
  DEPLOYED_SHA_MISSING: 'DEPLOYED_SHA_MISSING',
} as const;
