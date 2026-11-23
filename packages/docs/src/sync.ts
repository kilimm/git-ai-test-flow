// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { DocRepository } from '@gait/db';
import type { AppDatabase, Project } from '@gait/db';
import { estimateTokens } from '@gait/shared';
import type {
  DocCommitEntry,
  DocModuleDefinition,
  DocReferenceIssue,
  DocRollup,
} from '@gait/shared';
import { renderModuleDoc } from './builder.js';
import { compressDocEntries } from './compression.js';
import { inferModules, moduleForPath } from './manifest.js';
import { validateDocReferences } from './references.js';

export interface DocSyncCommit {
  sha: string;
  committedAt: number;
  author: string;
  title: string;
  files: string[];
  patch?: string;
}

export interface DocSyncInput {
  db: AppDatabase;
  tenantId: string;
  project: Project;
  headSha: string;
  commits: readonly DocSyncCommit[];
  repoFiles: readonly string[];
  knownTables?: readonly string[];
  moduleManifest?: readonly DocModuleDefinition[] | null;
  /** 由 Worker 写入 Suite 的 docsRoot；返回 true 表示文件有变化。 */
  writeDoc?: (path: string, content: string) => Promise<boolean> | boolean;
  now?: number;
}

export interface DocSyncResult {
  modules: Array<{
    key: string;
    path: string;
    content: string;
    tokenCount: number;
    references: DocReferenceIssue[];
    humanEdited: boolean;
  }>;
  entries: DocCommitEntry[];
  rollups: DocRollup[];
  written: string[];
  conflicts: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function summaryOf(commit: DocSyncCommit, modules: readonly string[]): string {
  return [
    `**${commit.title}**`,
    '',
    `- commit：\`${commit.sha}\``,
    `- 模块：${modules.length === 0 ? '未映射' : modules.join(', ')}`,
    `- 文件：${commit.files.length} 个`,
  ].join('\n');
}

function detailOf(commit: DocSyncCommit): string {
  const apiLines =
    commit.patch === undefined
      ? []
      : [...commit.patch.matchAll(/^[+-].*["'`]((?:GET|POST|PUT|PATCH|DELETE)\s+\/[^"'`]+)["'`]/gm)]
          .map((match) => match[1])
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 10)
          .map((value) => `- \`${value}\``);
  const lines = [
    '### 文件',
    '',
    ...commit.files.slice(0, 40).map((file) => `- \`${file}\``),
    ...(apiLines.length === 0 ? [] : ['', '### 接口', '', ...apiLines]),
  ];

  return lines.join('\n');
}

/**
 * Graph C 的持久化部分：
 * sync commits → map modules → T0 → 生成模块文档 → 引用校验 → T1-T3 → DB。
 * Git 提交由调用方（Worker）使用 SuiteRepository 完成。
 */
export async function syncProjectDocs(input: DocSyncInput): Promise<DocSyncResult> {
  const repository = new DocRepository(input.db, input.tenantId);
  const clock = input.now ?? Date.now();
  const repoFiles = [...new Set(input.repoFiles.map((file) => file.replace(/\\/g, '/')))];
  const allPaths = [
    ...repoFiles,
    ...input.commits.flatMap((commit) => commit.files.map((file) => file.replace(/\\/g, '/'))),
  ];
  const inferred =
    input.moduleManifest !== undefined && input.moduleManifest !== null
      ? [...input.moduleManifest]
      : inferModules(allPaths);
  const modules =
    inferred.length > 0
      ? inferred
      : [
          {
            key: 'general',
            name: '通用',
            description: '未映射到具体模块的变更。',
            pathPatterns: ['**/*'],
            owner: '',
            dependsOn: [],
          } satisfies DocModuleDefinition,
        ];

  for (const module of modules) {
    await repository.upsertModule({
      projectId: input.project.id,
      key: module.key,
      name: module.name,
      description: module.description,
      pathPatterns: module.pathPatterns,
      owner: module.owner,
      dependsOn: module.dependsOn,
      now: clock,
    });
  }

  const persistedModules = await repository.listModules(input.project.id);
  const persistedDefinitions = persistedModules.map((module) => ({
    row: module,
    definition: {
      key: module.key,
      name: module.name,
      description: module.description,
      pathPatterns: JSON.parse(module.pathPatternsJson) as string[],
      owner: module.owner,
      dependsOn: JSON.parse(module.dependsOnJson) as string[],
    } satisfies DocModuleDefinition,
  }));
  const definitions = persistedDefinitions.map((item) => item.definition);
  const entries: DocCommitEntry[] = [];
  const knownTables = new Set(input.knownTables ?? []);

  for (const commit of [...input.commits].sort((a, b) => a.committedAt - b.committedAt)) {
    const modulesOfCommit = [
      ...new Set(
        commit.files
          .map((file) => moduleForPath(definitions, file)?.key)
          .filter((key): key is string => key !== undefined),
      ),
    ];

    if (modulesOfCommit.length === 0) {
      modulesOfCommit.push(modules[0]?.key ?? 'general');
    }

    const summaryMd = summaryOf(commit, modulesOfCommit);
    const detailMd = detailOf(commit);
    const entry: DocCommitEntry = {
      commitSha: commit.sha,
      committedAt: commit.committedAt,
      author: commit.author,
      title: commit.title,
      summaryMd,
      detailMd,
      files: commit.files,
      modules: modulesOfCommit,
      tokenCount: estimateTokens(`${summaryMd}\n${detailMd}`),
    };

    entries.push(entry);
    await repository.upsertEntry({ ...entry, projectId: input.project.id, now: clock });
  }

  const allEntries = (await repository.listAllEntries(input.project.id)).map(
    (row): DocCommitEntry => ({
      commitSha: row.commitSha,
      committedAt: row.committedAt,
      author: row.author,
      title: row.title,
      summaryMd: row.summaryMd,
      detailMd: row.detailMd,
      files: JSON.parse(row.filesJson) as string[],
      modules: JSON.parse(row.modulesJson) as string[],
      tokenCount: row.tokenCount,
    }),
  );
  const rollups = compressDocEntries(allEntries);
  await repository.replaceRollups(
    input.project.id,
    rollups.map((rollup) => ({ ...rollup, projectId: input.project.id })),
    clock,
  );

  const result: DocSyncResult = {
    modules: [],
    entries: allEntries,
    rollups,
    written: [],
    conflicts: [],
  };
  const docsRoot = input.project.docsRoot.replace(/\/+$/, '');

  for (const { row: module, definition } of persistedDefinitions) {
    const moduleEntries = allEntries.filter((entry) => entry.modules.includes(definition.key));
    const moduleRollups = rollups.filter((rollup) =>
      rollup.sourceEntryIds.some((sha) => moduleEntries.some((entry) => entry.commitSha === sha)),
    );
    const modulePaths = definition.pathPatterns
      .map((pattern) => pattern.replace(/\*\*/g, '').replace(/\*/g, ''))
      .filter((value) => value.length > 0);
    const sourceFiles = repoFiles.filter((file) =>
      modulePaths.some((prefix) => file.includes(prefix.replace(/\/$/, ''))),
    );
    const references = validateDocReferences(
      renderModuleDoc({
        module: definition,
        entries: moduleEntries,
        rollups: moduleRollups,
        sourceFiles,
      }),
      new Set(repoFiles),
      knownTables,
    );
    const content = renderModuleDoc({
      module: definition,
      entries: moduleEntries,
      rollups: moduleRollups,
      sourceFiles,
      references,
    });
    const latest = await repository.latestVersion(module.id);
    const humanEdited = latest?.humanEdited === true;
    const path = `${docsRoot}/${module.key}.md`;
    let written = false;

    if (humanEdited && latest.contentMd !== content) {
      result.conflicts.push(module.key);
    } else if (input.writeDoc !== undefined) {
      written = await input.writeDoc(path, content);
    }

    if (written || !humanEdited) {
      if (latest !== undefined) {
        await repository.markVersionsSuperseded(module.id, clock);
      }

      await repository.createVersion({
        projectId: input.project.id,
        docModuleId: module.id,
        commitSha: input.headSha,
        contentMd: content,
        contentHash: sha256(content),
        summary: `${moduleEntries.length} 条 T0，${moduleRollups.length} 条压缩摘要`,
        sourceRefs: sourceFiles.slice(0, 100),
        generated: true,
        humanEdited: false,
        model: null,
        tokenCount: estimateTokens(content),
        status: written ? 'committed' : 'draft',
        now: clock,
      });
    }

    if (written) {
      result.written.push(path);
    }

    result.modules.push({
      key: definition.key,
      path,
      content,
      tokenCount: estimateTokens(content),
      references,
      humanEdited,
    });
  }

  await repository.updateSyncState(input.project.id, { lastProcessedSha: input.headSha }, clock);

  return result;
}
