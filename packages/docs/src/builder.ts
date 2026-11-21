// 本文件所有改动要求遵循 agent-rules 规范
import { estimateTokens } from '@gait/shared';
import type {
  DocCommitEntry,
  DocModuleDefinition,
  DocReferenceIssue,
  DocRollup,
} from '@gait/shared';

export interface ModuleDocInput {
  module: DocModuleDefinition;
  entries: readonly DocCommitEntry[];
  rollups: readonly DocRollup[];
  sourceFiles: readonly string[];
  references?: readonly DocReferenceIssue[];
}

const SECTION_TITLES = [
  '模块职责',
  '对外接口',
  '关键流程',
  '数据模型与表',
  '依赖与上下游',
  '配置与开关',
  '测试覆盖',
  '已知问题与限制',
  '变更历史',
] as const;

function filesUnder(module: DocModuleDefinition, sourceFiles: readonly string[]): string[] {
  return sourceFiles
    .filter((path) =>
      module.pathPatterns.some((pattern) => {
        const normalized = pattern.replace(/\*\*/g, '').replace(/\*/g, '');

        return normalized.length === 0 || path.includes(normalized.replace(/\/$/, ''));
      }),
    )
    .slice(0, 40);
}

function interfacesFrom(entries: readonly DocCommitEntry[]): string[] {
  const endpoints = new Set<string>();

  for (const entry of entries) {
    const matches = entry.detailMd.match(/`(?:GET|POST|PUT|PATCH|DELETE)\s+[^`]+`/g) ?? [];

    for (const match of matches) {
      endpoints.add(match.replaceAll('`', ''));
    }
  }

  return [...endpoints].slice(0, 20);
}

/** 生成稳定结构的模块文档；只使用 T0 原始条目，避免读取压缩摘要。 */
export function renderModuleDoc(input: ModuleDocInput): string {
  const { module, entries, rollups } = input;
  const relevantFiles = filesUnder(module, input.sourceFiles);
  const endpoints = interfacesFrom(entries);
  const recent = entries
    .slice()
    .sort((left, right) => right.committedAt - left.committedAt)
    .slice(0, 20);
  const stale = (input.references ?? []).filter((reference) => reference.stale);
  const lines = [
    `# ${module.name}`,
    '',
    `> 模块 key：\`${module.key}\` · 负责人：${module.owner || '未指定'} · 依赖：${
      module.dependsOn.join(', ') || '无'
    }`,
    '',
    `## ${SECTION_TITLES[0]}`,
    '',
    module.description || '待补充模块职责。',
    '',
    `## ${SECTION_TITLES[1]}`,
    '',
    ...(endpoints.length === 0
      ? ['暂未从最近提交识别到 HTTP/RPC/事件接口。']
      : endpoints.map((endpoint) => `- \`${endpoint}\``)),
    '',
    `## ${SECTION_TITLES[2]}`,
    '',
    '```mermaid',
    'flowchart LR',
    `  ${module.key.replace(/[^A-Za-z0-9_]/g, '_')} -->|依赖| ${(module.dependsOn[0] ?? 'external').replace(/[^A-Za-z0-9_]/g, '_')}`,
    '```',
    '',
    `## ${SECTION_TITLES[3]}`,
    '',
    ...(relevantFiles.length === 0
      ? ['暂无已索引的源码文件。']
      : relevantFiles.map((file) => `- \`${file}\``)),
    '',
    `## ${SECTION_TITLES[4]}`,
    '',
    module.dependsOn.length === 0
      ? '无显式模块依赖。'
      : module.dependsOn.map((key) => `- ${key}`).join('\n'),
    '',
    `## ${SECTION_TITLES[5]}`,
    '',
    '配置项以项目/环境配置为准；密钥不在文档中展示。',
    '',
    `## ${SECTION_TITLES[6]}`,
    '',
    `- Feature 用例引用模块 tag：\`@module:${module.key}\``,
    '- 最近提交与测试变更见变更历史。',
    '',
    `## ${SECTION_TITLES[7]}`,
    '',
    ...(stale.length === 0
      ? ['当前引用均有效。']
      : stale.map((reference) => `- [stale] \`${reference.reference}\`：${reference.message}`)),
    '',
    `## ${SECTION_TITLES[8]}`,
    '',
    '### T0 最近提交',
    '',
    ...(recent.length === 0
      ? ['暂无提交条目。']
      : recent.map(
          (entry) =>
            `- ${new Date(entry.committedAt).toISOString().slice(0, 10)} \`${entry.commitSha.slice(0, 8)}\` ${entry.title}`,
        )),
    '',
    ...rollups.map((rollup) => rollup.contentMd),
    '',
  ];

  return lines.join('\n');
}

export function docTokenCount(content: string): number {
  return estimateTokens(content);
}
