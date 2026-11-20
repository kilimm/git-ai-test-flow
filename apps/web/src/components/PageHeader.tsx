// 本文件所有改动要求遵循 agent-rules 规范
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}

export default function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow !== undefined && <div className="mb-1 text-xs text-gh-muted">{eyebrow}</div>}
        <h1 className="text-xl font-semibold text-gh-text">{title}</h1>
        {description !== undefined && (
          <div className="mt-1 text-sm text-gh-muted">{description}</div>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
