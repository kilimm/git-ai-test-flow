// 本文件所有改动要求遵循 agent-rules 规范
import { Empty } from 'antd';

export default function DiffViewer({ content }: { content: string }) {
  if (content.trim().length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有内容" />;
  }

  const lines = content.split('\n');

  return (
    <pre className="max-h-[480px] overflow-auto rounded-md border border-gh-border bg-[#f6f8fa] py-2 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const isAddition = line.startsWith('+') && !line.startsWith('+++');
        const isDeletion = line.startsWith('-') && !line.startsWith('---');
        const isHeader = line.startsWith('@@') || line.startsWith('diff --git');

        return (
          <div
            key={`${index}-${line.slice(0, 20)}`}
            className={`px-3 ${
              isAddition
                ? 'bg-[#dafbe1]'
                : isDeletion
                  ? 'bg-[#ffebe9]'
                  : isHeader
                    ? 'bg-[#ddf4ff] text-gh-muted'
                    : ''
            }`}
          >
            <span className="mr-3 inline-block w-8 select-none text-right text-gh-muted">
              {index + 1}
            </span>
            <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
          </div>
        );
      })}
    </pre>
  );
}
