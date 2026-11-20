// 本文件所有改动要求遵循 agent-rules 规范
import { Empty } from 'antd';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}

export default function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="py-8">
      <Empty
        image={icon ?? Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div className="space-y-1">
            <p className="text-sm font-medium text-gh-text">{title}</p>
            {description !== undefined && <p className="text-sm text-gh-muted">{description}</p>}
          </div>
        }
      >
        {action}
      </Empty>
    </div>
  );
}
