// 本文件所有改动要求遵循 agent-rules 规范
import { GherkinLine } from './StepEditor';

interface TerminalStepsProps {
  lines: readonly string[];
}

/** 只读 Gherkin 预览：关键字加粗着色，行号对齐，等宽字体。 */
export default function TerminalSteps({ lines }: TerminalStepsProps) {
  return (
    <pre className="max-h-[30rem] overflow-auto rounded border border-gh-border bg-gh-canvas p-3 font-mono text-xs leading-5">
      {lines.length === 0 ? (
        <span className="text-gh-muted">（空）</span>
      ) : (
        lines.map((line, index) => (
          <div key={index} className="flex gap-3">
            <span className="w-8 shrink-0 select-none text-right text-gh-muted opacity-60">
              {index + 1}
            </span>
            <span className="whitespace-pre-wrap break-all">
              {line.length === 0 ? ' ' : <GherkinLine line={line} />}
            </span>
          </div>
        ))
      )}
    </pre>
  );
}
