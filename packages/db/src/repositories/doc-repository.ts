// 本文件所有改动要求遵循 agent-rules 规范
import { and, asc, desc, eq, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { DocCommitEntry, DocRollup } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { MAX_SEARCH_TOKENS, containsToken } from '../search.js';
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

  async listModules(projectId: string): Promise<DocModule[]> {
    return this.db
      .select()
      .from(docModules)
      .where(and(eq(docModules.tenantId, this.tenantId), eq(docModules.projectId, projectId)))
      .orderBy(asc(docModules.key));
  }

  async findModule(projectId: string, keyOrId: string): Promise<DocModule | undefined> {
    const [row] = await this.db
      .select()
      .from(docModules)
      .where(
        and(
          eq(docModules.tenantId, this.tenantId),
          eq(docModules.projectId, projectId),
          eq(docModules.id, keyOrId),
        ),
      )
      .limit(1);

    return row;
  }

  async findModuleById(id: string): Promise<DocModule | undefined> {
    const [row] = await this.db
      .select()
      .from(docModules)
      .where(and(eq(docModules.tenantId, this.tenantId), eq(docModules.id, id)))
      .limit(1);

    return row;
  }

  async findModuleByKey(projectId: string, key: string): Promise<DocModule | undefined> {
    const [row] = await this.db
      .select()
      .from(docModules)
      .where(
        and(
          eq(docModules.tenantId, this.tenantId),
          eq(docModules.projectId, projectId),
          eq(docModules.key, key),
        ),
      )
      .limit(1);

    return row;
  }

  async upsertModule(input: UpsertDocModuleInput): Promise<DocModule> {
    const now = input.now ?? nowMs();
    const [module] = await this.db
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
      .returning();

    const saved = requireRow(module);
    await this.refreshSearch(saved.id);

    return saved;
  }

  async createVersion(input: CreateDocVersionInput): Promise<DocVersion> {
    const now = input.now ?? nowMs();
    const [version] = await this.db
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
      .returning();

    const saved = requireRow(version);
    await this.refreshSearch(input.docModuleId);

    return saved;
  }

  async listVersions(docModuleId: string, limit = 20): Promise<DocVersion[]> {
    return this.db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.tenantId, this.tenantId), eq(docVersions.docModuleId, docModuleId)))
      .orderBy(desc(docVersions.createdAt), desc(docVersions.id))
      .limit(limit);
  }

  async latestVersion(docModuleId: string): Promise<DocVersion | undefined> {
    const [version] = await this.listVersions(docModuleId, 1);

    return version;
  }

  async findVersion(id: string): Promise<DocVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.tenantId, this.tenantId), eq(docVersions.id, id)))
      .limit(1);

    return row;
  }

  async markVersionsSuperseded(docModuleId: string, now = nowMs()): Promise<void> {
    await this.db
      .update(docVersions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(docVersions.tenantId, this.tenantId),
          eq(docVersions.docModuleId, docModuleId),
          eq(docVersions.status, 'committed'),
        ),
      );
    void now;
  }

  async upsertEntry(input: CreateDocEntryInput): Promise<DocCommitEntryRow> {
    const now = input.now ?? nowMs();
    const id = uuidv7(now);
    const [row] = await this.db
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
      .returning();

    return requireRow(row);
  }

  async listEntries(projectId: string, limit = 100): Promise<DocCommitEntryRow[]> {
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
      .limit(limit);
  }

  async listAllEntries(projectId: string): Promise<DocCommitEntryRow[]> {
    return this.db
      .select()
      .from(docCommitEntries)
      .where(
        and(
          eq(docCommitEntries.tenantId, this.tenantId),
          eq(docCommitEntries.projectId, projectId),
        ),
      )
      .orderBy(desc(docCommitEntries.committedAt), desc(docCommitEntries.id));
  }

  async replaceRollups(
    projectId: string,
    rollups: readonly CreateDocRollupInput[],
    now = nowMs(),
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(docRollups)
        .where(and(eq(docRollups.tenantId, this.tenantId), eq(docRollups.projectId, projectId)));

      for (const rollup of rollups) {
        await tx.insert(docRollups).values({
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
        });
      }
    });
  }

  async listRollups(projectId: string): Promise<DocRollupRow[]> {
    return this.db
      .select()
      .from(docRollups)
      .where(and(eq(docRollups.tenantId, this.tenantId), eq(docRollups.projectId, projectId)))
      .orderBy(asc(docRollups.periodEnd));
  }

  async getSyncState(projectId: string): Promise<DocSyncStateRow | undefined> {
    const [row] = await this.db
      .select()
      .from(docSyncState)
      .where(and(eq(docSyncState.tenantId, this.tenantId), eq(docSyncState.projectId, projectId)))
      .limit(1);

    return row;
  }

  async updateSyncState(
    projectId: string,
    input: { lastProcessedSha?: string | null; lastDocCommitSha?: string | null },
    now = nowMs(),
  ): Promise<void> {
    await this.db
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
      });
  }

  /** 刷新模块检索缓存：名称、描述与最新版本正文拼接后写入 search_text。 */
  async refreshSearch(docModuleId: string): Promise<void> {
    const module = await this.findModuleById(docModuleId);

    if (module === undefined) {
      return;
    }

    const latest = await this.latestVersion(docModuleId);
    await this.db
      .update(docModules)
      .set({
        searchText: [module.name, module.description, latest?.contentMd ?? ''].join('\n'),
      })
      .where(eq(docModules.id, docModuleId));
  }

  async searchModules(projectId: string, query: string, limit = 20): Promise<DocModule[]> {
    const tokens = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.replace(/["']/g, ''))
      .filter((token) => token.length > 0)
      .slice(0, MAX_SEARCH_TOKENS);

    if (tokens.length === 0) {
      return this.listModules(projectId);
    }

    const tokenCondition = or(
      ...tokens.map((token) =>
        or(
          containsToken(docModules.name, token),
          containsToken(docModules.description, token),
          containsToken(docModules.searchText, token),
        ),
      ),
    );
    const conditions: SQL[] = [
      eq(docModules.tenantId, this.tenantId),
      eq(docModules.projectId, projectId),
    ];

    if (tokenCondition !== undefined) {
      conditions.push(tokenCondition);
    }

    return this.db
      .select()
      .from(docModules)
      .where(and(...conditions))
      .orderBy(desc(docModules.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 50));
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
