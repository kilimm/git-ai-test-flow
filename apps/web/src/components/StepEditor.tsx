// 本文件所有改动要求遵循 agent-rules 规范
import { Fragment, useMemo, useRef, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Select, Tag } from 'antd';
import { Check, Sparkles, Undo2, Wand2 } from 'lucide-react';

export interface StepSuggestion {
  pattern: string;
  meaning: string;
  example: string;
}

/**
 * Gherkin 行内 step 快捷补全：
 *
 * - 根据「当前行的关键字 + 已输入文字」匹配脚本库的 step 句式；
 * - 匹配把 pattern 里的占位符（{string}/{int}/{word}/{anything}）展开成正则；
 * - 选中后把整行替换为示例句式，并把光标定位到第一个占位符处，便于继续填写。
 *
 * 补全只作用于以 Given/When/Then/And/But（及中文对应关键字）开头的行，
 * 不会在注释、tag 或场景标题里触发。
 */

const KEYWORDS = [
  'Given',
  'When',
  'Then',
  'And',
  'But',
  '*',
  '假如',
  '假设',
  '当',
  '那么',
  '而且',
  '并且',
  '但是',
];

const KEYWORD_PATTERN = /^(\s*)(Given|When|Then|And|But|\*|假如|假设|当|那么|而且|并且|但是)(\s+)/;

/** pattern 占位符 → 正则片段（宽松，用于前缀匹配用户已输入的文字）。 */
function compilePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`)
    .replace(/\\\{string\\\}/g, '"[^"]*"?')
    .replace(/\\\{int\\\}/g, '-?\\d*')
    .replace(/\\\{word\\\}/g, '[A-Za-z0-9_-]*')
    .replace(/\\\{anything\\\}/g, '.+');

  return new RegExp(`^${escaped}$`, 'i');
}

/** 用示例值替换 pattern 里的占位符，生成可编辑的句式。 */
export function fillPlaceholders(pattern: string, values: Record<string, string>): string {
  return pattern
    .replace(/\{string\}/g, `"${values.string ?? '文本'}"`)
    .replace(/\{int\}/g, values.int ?? '1')
    .replace(/\{word\}/g, values.word ?? 'value')
    .replace(/\{anything\}/g, values.anything ?? '任意内容')
    .replace(/\{method\}/g, values.method ?? 'GET');
}

interface StepEditorProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: StepSuggestion[];
  /** 编辑区尺寸。 */
  rows?: number;
  disabled?: boolean;
}

export default function StepEditor({
  value,
  onChange,
  suggestions,
  rows = 18,
  disabled = false,
}: StepEditorProps) {
  const { message } = AntdApp.useApp();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const lines = value.split('\n');
  const currentLine = caretLine === null ? null : (lines[caretLine] ?? '');

  const stepMatch = currentLine === null ? null : KEYWORD_PATTERN.exec(currentLine);
  const typedStep =
    stepMatch === null || currentLine === null
      ? ''
      : currentLine.slice((stepMatch[0] ?? '').length).trim();

  const candidates = useMemo(() => {
    if (stepMatch === null) {
      return [];
    }

    const keyword = stepMatch[2] ?? '';
    const typed = typedStep.toLowerCase();
    const scored: { suggestion: StepSuggestion; score: number; expansion: string }[] = [];

    for (const suggestion of suggestions) {
      const expansion = fillPlaceholders(suggestion.pattern, {});
      // keyword 不同也给候选，但排序靠后：用户常写 And 续接不同性子的 step。
      const keywordBonus = expansion.toLowerCase().startsWith(`${keyword.toLowerCase()} `) ? 0 : 1;
      const matcher = compilePattern(suggestion.pattern);
      const withoutKeyword = expansion.replace(/^\w+\s+/, '');
      const typedMatchesBody =
        typed.length === 0 || withoutKeyword.toLowerCase().startsWith(typed) || matcher.test(typed);
      const patternMatches = typed.length === 0 || matcher.test(typed);

      if (!typedMatchesBody && !patternMatches) {
        continue;
      }

      const score = keywordBonus * 10 + (withoutKeyword.toLowerCase().startsWith(typed) ? 0 : 5);
      scored.push({ suggestion, score, expansion });
    }

    return scored.sort((left, right) => left.score - right.score).slice(0, 20);
  }, [suggestions, stepMatch, typedStep]);

  const syncCaret = (): void => {
    const element = textareaRef.current;

    if (element === null) {
      return;
    }

    const before = element.value.slice(0, element.selectionStart ?? 0);
    setCaretLine(before.split('\n').length - 1);
  };

  const applySuggestion = (suggestion: StepSuggestion): void => {
    if (caretLine === null || currentLine === null) {
      return;
    }

    const match = KEYWORD_PATTERN.exec(currentLine);
    const indent = match?.[1] ?? '  ';
    const keyword = match?.[2] ?? 'Given';
    const body = suggestion.pattern.replace(/^\w+\s+/, '');
    const filled = fillPlaceholders(body, {});
    const nextLine = `${indent}${keyword} ${filled}`;
    const nextLines = [...lines];
    nextLines[caretLine] = nextLine;
    const next = nextLines.join('\n');

    setHistory((previous) => [...previous.slice(-19), value]);
    onChange(next);

    // 光标落到第一个占位符内容处。
    const firstPlaceholder = /\{string\}|\{int\}|\{word\}|\{anything\}|"[^"]*"/.exec(nextLine);
    const offset =
      firstPlaceholder === null
        ? nextLine.length
        : nextLines.slice(0, caretLine).join('\n').length + 1 + firstPlaceholder.index;

    requestAnimationFrame(() => {
      const element = textareaRef.current;

      if (element !== null) {
        element.focus();
        element.setSelectionRange(offset + 1, offset + 1);
      }
    });

    message.success('已插入 step 句式，继续补全参数即可');
  };

  const undo = (): void => {
    const previous = history[history.length - 1];

    if (previous === undefined) {
      return;
    }

    setHistory((rest) => rest.slice(0, -1));
    onChange(previous);
  };

  return (
    <div className="space-y-2">
      {stepMatch !== null && (
        <Card
          size="small"
          title={
            <span className="flex items-center gap-2 text-xs">
              <Wand2 size={13} /> Step 快捷输入（{candidates.length} 条候选）
            </span>
          }
          extra={
            history.length > 0 && (
              <Button size="small" type="text" icon={<Undo2 size={13} />} onClick={undo}>
                撤销补全
              </Button>
            )
          }
        >
          {candidates.length === 0 ? (
            <p className="m-0 text-xs text-gh-muted">
              没有匹配的 step 句式；可在脚本库中新增，或检查已输入文字是否有拼写差异。
            </p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-auto">
              {candidates.map(({ suggestion, expansion }) => (
                <button
                  key={suggestion.pattern}
                  type="button"
                  onClick={() => applySuggestion(suggestion)}
                  className="flex w-full items-start gap-2 rounded border border-transparent px-2 py-1 text-left text-xs hover:border-gh-border hover:bg-[#f6f8fa]"
                >
                  <Check size={13} className="mt-0.5 shrink-0 text-gh-green" />
                  <span className="flex-1">
                    <code className="break-all">{expansion}</code>
                    {suggestion.meaning.length > 0 && (
                      <span className="ml-2 text-gh-muted">{suggestion.meaning}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {stepMatch === null && (
        <Alert
          type="info"
          showIcon
          icon={<Sparkles size={14} />}
          message="把光标放到 Given / When / Then 行即可获得 step 快捷输入"
        />
      )}

      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        spellCheck={false}
        rows={rows}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onChange={(event) => {
          onChange(event.target.value);
          syncCaret();
        }}
        className="w-full rounded border border-gh-border bg-white p-3 font-mono text-xs leading-5 outline-none focus:border-gh-blue"
      />

      {caretLine !== null && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gh-muted">
          <Tag className="font-mono">行 {caretLine + 1}</Tag>
          <Select
            size="small"
            className="w-40"
            placeholder="快捷关键字"
            value={stepMatch?.[2]}
            options={KEYWORDS.map((keyword) => ({ value: keyword, label: keyword }))}
            onChange={(keyword) => {
              if (caretLine === null) {
                return;
              }

              const line = lines[caretLine] ?? '';
              const rest = line.replace(KEYWORD_PATTERN, `$1$3`);
              const nextLines = [...lines];
              nextLines[caretLine] = `${line.match(/^\s*/)?.[0] ?? ''}${keyword} ${rest.trimStart()}`;
              onChange(nextLines.join('\n'));
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 把一行渲染成高亮 token（仅用于只读预览）。 */
export function GherkinLine({ line }: { line: string }) {
  if (/^\s*#/.test(line)) {
    return <span className="text-gh-muted">{line}</span>;
  }

  const keywordMatch = KEYWORD_PATTERN.exec(line);

  if (keywordMatch === null) {
    return <span>{line}</span>;
  }

  const [whole, indent, keyword, space] = keywordMatch;

  return (
    <Fragment>
      <span>{indent}</span>
      <span className="font-semibold text-[#8250df]">{keyword}</span>
      <span>{space}</span>
      <span>{line.slice(whole.length)}</span>
    </Fragment>
  );
}
