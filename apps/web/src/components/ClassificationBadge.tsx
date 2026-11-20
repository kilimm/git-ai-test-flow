// 本文件所有改动要求遵循 agent-rules 规范
import { Tag, Tooltip } from 'antd';
import type { Classification } from '@gait/shared';

const LABELS: Readonly<Record<Classification, string>> = {
  code_bug: '代码缺陷',
  test_bug: '用例问题',
  env_issue: '环境问题',
  flaky: '偶发失败',
  unknown: '待确认',
};

const COLORS: Readonly<Record<Classification, string>> = {
  code_bug: 'red',
  test_bug: 'gold',
  env_issue: 'blue',
  flaky: 'purple',
  unknown: 'default',
};

export default function ClassificationBadge({
  classification,
  confidence,
}: {
  classification: Classification | null;
  confidence?: number | null;
}) {
  if (classification === null) {
    return <Tag>未归因</Tag>;
  }

  return (
    <Tooltip
      title={confidence === null || confidence === undefined ? undefined : `置信度 ${confidence}%`}
    >
      <Tag color={COLORS[classification]}>{LABELS[classification]}</Tag>
    </Tooltip>
  );
}

export { LABELS as CLASSIFICATION_LABELS };
