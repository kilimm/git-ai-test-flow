// 本文件所有改动要求遵循 agent-rules 规范
import { Collapse, Tag } from 'antd';
import { CheckCircle2, CircleAlert, CircleX, Clock3 } from 'lucide-react';
import type { StepResult } from '../api/types';
import ArtifactPreview from './ArtifactPreview';
import StatusBadge from './StatusBadge';

function messageOf(value: Record<string, unknown> | null): string | null {
  if (value === null) {
    return null;
  }

  const message = value.message;

  return typeof message === 'string' ? message : JSON.stringify(value, null, 2);
}

function StepIcon({ status }: { status: string }) {
  if (status === 'passed') {
    return <CheckCircle2 size={17} className="text-gh-green" />;
  }

  if (status === 'failed' || status === 'error') {
    return <CircleX size={17} className="text-gh-danger" />;
  }

  if (status === 'running') {
    return <Clock3 size={17} className="text-gh-blue" />;
  }

  return <CircleAlert size={17} className="text-gh-muted" />;
}

export default function StepTimeline({ runId, steps }: { runId: string; steps: StepResult[] }) {
  if (steps.length === 0) {
    return <p className="text-sm text-gh-muted">没有步骤记录。</p>;
  }

  return (
    <div className="divide-y divide-gh-border rounded-md border border-gh-border">
      {steps.map((step) => {
        const errorMessage = messageOf(step.error);

        return (
          <div key={step.id} className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StepIcon status={step.status} />
              <span className="font-mono text-xs text-gh-muted">#{step.index}</span>
              <span className="text-sm font-medium text-gh-text">{step.keyword}</span>
              <span className="min-w-0 flex-1 text-sm text-gh-text">{step.text}</span>
              <Tag>{step.type}</Tag>
              <StatusBadge status={step.status} />
              {step.durationMs !== null && (
                <span className="text-xs text-gh-muted">{step.durationMs}ms</span>
              )}
            </div>

            {errorMessage !== null && (
              <div className="mt-2 rounded border border-[#ffebe9] bg-[#ffebe9] p-2 font-mono text-xs text-gh-danger">
                {errorMessage}
              </div>
            )}

            {step.artifacts.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3">
                {step.artifacts.map((artifact, index) => (
                  <ArtifactPreview
                    key={artifact.id ?? `${index}`}
                    runId={runId}
                    artifact={artifact}
                  />
                ))}
              </div>
            )}

            {(Object.keys(step.output).length > 0 || errorMessage !== null) && (
              <Collapse
                ghost
                size="small"
                className="mt-1"
                items={[
                  {
                    key: 'detail',
                    label: <span className="text-xs text-gh-muted">输入/输出详情</span>,
                    children: (
                      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-gh-canvas p-2 font-mono text-xs">
                        {JSON.stringify(step.output, null, 2)}
                      </pre>
                    ),
                  },
                ]}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
