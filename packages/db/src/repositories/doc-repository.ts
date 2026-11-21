// 本文件所有改动要求遵循 agent-rules 规范
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { DocCommitEntry, DocRollup } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { docCommitEntries, docModules, docRollups, docSyncState, docVersions } from '../schema.js';
import type {
  DocCommitEntryRow,
  DocModule,
  DocRollupRow,
  DocSyncStateRow,
  DocVersion,
} from '../schema.js';

export interface UpsertDocModuleInput {
  id?: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  pathPatterns: string[];
  owner?: string;
  dependsOn?: string[];
  status?: string;
  now?: number;
}

export interface CreateDocVersionInput {
  projectId: string;
  docModuleId: string;
  commitSha: string;
  contentMd: string;
  contentHash: string;
  summary?: string | null;
  sourceRefs?: string[];
  generated?: boolean;
  humanEdited?: boolean;
  model?: string | null;
  promptVersion?: string | null;
  tokenCount?: number;
  status?: string;
  now?: number;
}

export interface CreateDocEntryInput extends DocCommitEntry {
  projectId: string;
  now?: number;
}

export interface CreateDocRollupInput extends DocRollup {
  projectId: string;
  docModuleId?: string | null;
  now?: number;
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export class DocRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  listModules(projectId: string): DocModule[] {
    return this.db
      .select()
      .from(docModules)
      .where(and(eq(docModules.tenantId, this.tenantId), eq(docModules.projectId, projectId)))
      .orderBy(asc(docModules.key))
      .all();
  }

  findModule(projectId: string, keyOrId: string): DocModule | undefined {
    return this.db
      .select()
      .from(docModules)
      .where(
        and(
          eq(docModules.tenantId, this.tenantId),
          eq(docModules.projectId, projectId),
          eq(docModules.id, keyOrId),
        ),
      )
      .get();
  }

  findModuleById(id: string): DocModule | undefined {
    return this.db
      .select()
      .from(docModules)
      .where(and(eq(docModules.tenantId, this.tenantId), eq(docModules.id, id)))
      .get();
  }

  findModuleByKey(projectId: string, key: string): DocModule | undefined {
    return this.db
      .select()
      .from(docModules)
      .where(
        and(
          eq(docModules.tenantId, this.tenantId),
          eq(docModules.projectId, projectId),
          eq(docModules.key, key),
        ),
      )
      .get();
  }

  upsertModule(input: UpsertDocModuleInput): DocModule {
    const now = input.now ?? nowMs();
    const module = this.db
      .insert(docModules)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        pathPatternsJson: JSON.stringify(input.pathPatterns),
        owner: input.owner ?? '',
        dependsOnJson: JSON.stringify(input.dependsOn ?? []),
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [docModules.projectId, docModules.key],
        set: {
          name: input.name,
          description: input.description ?? '',
          pathPatternsJson: JSON.stringify(input.pathPatterns),
          owner: input.owner ?? '',
          dependsOnJson: JSON.stringify(input.dependsOn ?? []),
          status: input.status ?? 'active',
          updatedAt: now,
        },
      })
      .returning()
      .get() as DocModule;

    this.refreshSearch(module.id);

    return module;
  }

  createVersion(input: CreateDocVersionInput): DocVersion {
    const now = input.now ?? nowMs();
    const version = this.db
      .insert(docVersions)
      .values({
        id: uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        docModuleId: input.docModuleId,
        commitSha: input.commitSha,
        contentMd: input.contentMd,
        contentHash: input.contentHash,
        summary: input.summary ?? null,
        sourceRefsJson: JSON.stringify(input.sourceRefs ?? []),
        generated: input.generated ?? true,
        humanEdited: input.humanEdited ?? false,
        model: input.model ?? null,
        promptVersion: input.promptVersion ?? null,
        tokenCount: input.tokenCount ?? 0,
        status: input.status ?? 'draft',
        createdAt: now,
      })
      .returning()
      .get() as DocVersion;

    this.refreshSearch(input.docModuleId);

    return version;
  }

  listVersions(docModuleId: string, limit = 20): DocVersion[] {
    return this.db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.tenantId, this.tenantId), eq(docVersions.docModuleId, docModuleId)))
      .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
      .limit(limit)
      .all();
  }

  latestVersion(docModuleId: string): DocVersion | undefined {
    return this.listVersions(docModuleId, 1)[0];
  }

  findVersion(id: string): DocVersion | undefined {
    return this.db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.tenantId, this.tenantId), eq(docVersions.id, id)))
      .get();
  }

  markVersionsSuperseded(docModuleId: string, now = nowMs()): void {
    this.db
      .update(docVersions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(docVersions.tenantId, this.tenantId),
          eq(docVersions.docModuleId, docModuleId),
          eq(docVersions.status, 'committed'),
        ),
      )
      .run();
    void now;
  }

  upsertEntry(input: CreateDocEntryInput): DocCommitEntryRow {
    const now = input.now ?? nowMs();
    const id = uuidv7(now);

    return this.db
      .insert(docCommitEntries)
      .values({
        id,
        tenantId: this.tenantId,
        projectId: input.projectId,
        commitSha: input.commitSha,
        committedAt: input.committedAt,
        author: input.author,
        title: input.title,
        summaryMd: input.summaryMd,
        detailMd: input.detailMd,
        filesJson: JSON.stringify(input.files),
        modulesJson: JSON.stringify(input.modules),
        tokenCount: input.tokenCount,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [docCommitEntries.projectId, docCommitEntries.commitSha],
        set: {
          committedAt: input.committedAt,
          author: input.author,
          title: input.title,
          summaryMd: input.summaryMd,
          detailMd: input.detailMd,
          filesJson: JSON.stringify(input.files),
          modulesJson: JSON.stringify(input.modules),
          tokenCount: input.tokenCount,
        },
      })
      .returning()
      .get() as DocCommitEntryRow;
  }

  listEntries(projectId: string, limit = 100): DocCommitEntryRow[] {
    return this.db
      .select()
      .from(docCommitEntries)
      .where(
        and(
          eq(docCommitEntries.tenantId, this.tenantId),
          eq(docCommitEntries.projectId, projectId),
        ),
      )
      .orderBy(desc(docCommitEntries.committedAt), desc(docCommitEntries.id))
      .limit(limit)
      .all();
  }

  listAllEntries(projectId: string): DocCommitEntryRow[] {
    return this.db
      .select()
      .from(docCommitEntries)
      .where(
        and(
          eq(docCommitEntries.tenantId, this.tenantId),
          eq(docCommitEntries.projectId, projectId),
        ),
      )
      .orderBy(desc(docCommitEntries.committedAt), desc(docCommitEntries.id))
      .all();
  }

  replaceRollups(projectId: string, rollups: readonly CreateDocRollupInput[], now = nowMs()): void {
    this.db
      .delete(docRollups)
      .where(and(eq(docRollups.tenantId, this.tenantId), eq(docRollups.projectId, projectId)))
      .run();

    for (const rollup of rollups) {
      this.db
        .insert(docRollups)
        .values({
          id: uuidv7(now),
          tenantId: this.tenantId,
          projectId,
          docModuleId: rollup.docModuleId ?? null,
          tier: rollup.tier,
          periodStart: rollup.periodStart,
          periodEnd: rollup.periodEnd,
          commitCount: rollup.commitCount,
          contentMd: rollup.contentMd,
          sourceShaRange: JSON.stringify(rollup.sourceShaRange).slice(0, 1_000),
          sourceEntryIdsJson: JSON.stringify(rollup.sourceEntryIds),
          tokenCount: rollup.tokenCount,
          createdAt: now,
        })
        .run();
    }
  }

  listRollups(projectId: string): DocRollupRow[] {
    return this.db
      .select()
      .from(docRollups)
      .where(and(eq(docRollups.tenantId, this.tenantId), eq(docRollups.projectId, projectId)))
      .orderBy(asc(docRollups.periodEnd))
      .all();
  }

  getSyncState(projectId: string): DocSyncStateRow | undefined {
    return this.db
      .select()
      .from(docSyncState)
      .where(and(eq(docSyncState.tenantId, this.tenantId), eq(docSyncState.projectId, projectId)))
      .get();
  }

  updateSyncState(
    projectId: string,
    input: { lastProcessedSha?: string | null; lastDocCommitSha?: string | null },
    now = nowMs(),
  ): void {
    this.db
      .insert(docSyncState)
      .values({
        projectId,
        tenantId: this.tenantId,
        lastProcessedSha: input.lastProcessedSha ?? null,
        lastDocCommitSha: input.lastDocCommitSha ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: docSyncState.projectId,
        set: {
          ...(input.lastProcessedSha === undefined
            ? {}
            : { lastProcessedSha: input.lastProcessedSha }),
          ...(input.lastDocCommitSha === undefined
            ? {}
            : { lastDocCommitSha: input.lastDocCommitSha }),
          updatedAt: now,
        },
      })
      .run();
  }

  /** 文档 FTS5 重建：删除旧行后重新插入模块与最新版本正文。 */
  refreshSearch(docModuleId: string): void {
    const module = this.findModuleById(docModuleId);

    if (module === undefined) {
      return;
    }

    const latest = this.latestVersion(docModuleId);

    try {
      this.db.run(sql`DELETE FROM doc_modules_fts WHERE doc_module_id = ${docModuleId}`);
      this.db.run(sql`
        INSERT INTO doc_modules_fts (doc_module_id, project_id, key, name, description, content)
        VALUES (
          ${module.id},
          ${module.projectId},
          ${module.key},
          ${module.name},
          ${module.description},
          ${latest?.contentMd ?? ''}
        )
      `);
    } catch {
      // FTS 表在旧库尚未迁移时不影响主流程；迁移后会自然补齐。
    }
  }

  searchModules(projectId: string, query: string, limit = 20): DocModule[] {
    const tokens = query
      .trim()
      .split(/\s+/)
      .map((token) => token.replace(/["']/g, ''))
      .filter((token) => token.length > 0);

    if (tokens.length === 0) {
      return this.listModules(projectId);
    }

    const match = tokens.map((token) => `"${token}"`).join(' OR ');

    try {
      const rows = this.db.all<{ doc_module_id: string }>(sql`
        SELECT doc_module_id FROM doc_modules_fts
        WHERE doc_modules_fts MATCH ${match}
          AND project_id = ${projectId}
        LIMIT ${Math.min(limit, 50)}
      `);
      const modules: DocModule[] = [];

      for (const row of rows) {
        const module = this.findModuleById(row.doc_module_id);

        if (module !== undefined && module.projectId === projectId) {
          modules.push(module);
        }
      }

      return modules;
    } catch {
      return this.listModules(projectId);
    }
  }

  entryView(row: DocCommitEntryRow): {
    id: string;
    commitSha: string;
    committedAt: number;
    author: string;
    title: string;
    summaryMd: string;
    modules: string[];
    tokenCount: number;
  } {
    return {
      id: row.id,
      commitSha: row.commitSha,
      committedAt: row.committedAt,
      author: row.author,
      title: row.title,
      summaryMd: row.summaryMd,
      modules: parseArray<string>(row.modulesJson),
      tokenCount: row.tokenCount,
    };
  }
}
