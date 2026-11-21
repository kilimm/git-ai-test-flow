// 本文件所有改动要求遵循 agent-rules 规范
import type { ReactNode } from 'react';

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-gh-canvas px-1 py-0.5 font-mono text-xs">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);

      if (link !== null) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-gh-blue underline"
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/** 轻量 Markdown 渲染：仅覆盖项目文档模板使用的标题/列表/代码/表格样式。 */
export default function MarkdownView({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: ReactNode[] = [];
  let codeBlock: string[] | null = null;
  let listItems: string[] = [];

  const flushList = (): void => {
    if (listItems.length === 0) {
      return;
    }

    elements.push(
      <ul key={`list-${elements.length}`} className="my-2 list-disc space-y-1 pl-5 text-sm">
        {listItems.map((item, index) => (
          <li key={`${index}-${item.slice(0, 12)}`}>
            {inline(item, `li-${elements.length}-${index}`)}
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (codeBlock === null) {
        flushList();
        codeBlock = [];
      } else {
        elements.push(
          <pre
            key={`code-${elements.length}`}
            className="my-2 overflow-auto rounded border border-gh-border bg-gh-canvas p-3 text-xs"
          >
            {codeBlock.join('\n')}
          </pre>,
        );
        codeBlock = null;
      }

      continue;
    }

    if (codeBlock !== null) {
      codeBlock.push(line);
      continue;
    }

    if (line.startsWith('# ')) {
      flushList();
      elements.push(
        <h1 key={`h1-${elements.length}`} className="mb-2 mt-4 text-xl font-semibold">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith('## ')) {
      flushList();
      elements.push(
        <h2
          key={`h2-${elements.length}`}
          className="mb-2 mt-4 border-b border-gh-border pb-1 text-base font-semibold"
        >
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('### ')) {
      flushList();
      elements.push(
        <h3 key={`h3-${elements.length}`} className="mb-1 mt-3 text-sm font-semibold">
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith('> ')) {
      flushList();
      elements.push(
        <blockquote
          key={`quote-${elements.length}`}
          className="my-2 border-l-4 border-gh-border bg-gh-canvas px-3 py-2 text-sm text-gh-muted"
        >
          {inline(line.slice(2), `quote-${elements.length}`)}
        </blockquote>,
      );
    } else if (/^[-*] /.test(line)) {
      listItems.push(line.slice(2));
    } else if (line.trim().length === 0) {
      flushList();
    } else {
      flushList();
      elements.push(
        <p key={`p-${elements.length}`} className="my-1 text-sm leading-6">
          {inline(line, `p-${elements.length}`)}
        </p>,
      );
    }
  }

  flushList();

  if (codeBlock !== null) {
    elements.push(
      <pre
        key={`code-open-${elements.length}`}
        className="my-2 overflow-auto rounded bg-gh-canvas p-3 text-xs"
      >
        {codeBlock.join('\n')}
      </pre>,
    );
  }

  return <div className="max-w-none">{elements}</div>;
}
