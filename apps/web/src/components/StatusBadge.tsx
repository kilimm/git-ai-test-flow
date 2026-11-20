// 本文件所有改动要求遵循 agent-rules 规范
import { Tag } from 'antd';

const LABELS: Readonly<Record<string, string>> = {
  queued: '排队中',
  preparing: '准备中',
  running: '执行中',
  analyzing: '归因中',
  validating: '校验中',
  reporting: '生成报告中',
  awaiting_approval: '等待审批',
  succeeded: '成功',
  passed: '通过',
  failed: '失败',
  error: '错误',
  skipped: '跳过',
  canceled: '已取消',
  committed: '已提交',
  rejected: '已拒绝',
  no_op: '无变更',
  quarantined: '已隔离',
  pending: '等待中',
  active: '有效',
  obsolete: '过时',
  healthy: '健康',
  unhealthy: '异常',
  unknown: '未知',
};

const COLORS: Readonly<Record<string, string>> = {
  queued: 'default',
  preparing: 'processing',
  running: 'processing',
  analyzing: 'processing',
  validating: 'processing',
  reporting: 'processing',
  awaiting_approval: 'gold',
  succeeded: 'green',
  passed: 'green',
  failed: 'red',
  error: 'volcano',
  skipped: 'default',
  canceled: 'default',
  committed: 'green',
  rejected: 'red',
  no_op: 'blue',
  quarantined: 'orange',
  pending: 'default',
  active: 'green',
  obsolete: 'default',
  healthy: 'green',
  unhealthy: 'red',
  unknown: 'default',
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export default function StatusBadge({ status }: { status: string }) {
  return <Tag color={COLORS[status] ?? 'default'}>{statusLabel(status)}</Tag>;
}
