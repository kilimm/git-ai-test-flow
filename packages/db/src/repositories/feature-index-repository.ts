// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { MAX_SEARCH_TOKENS, containsToken } from '../search.js';
import { featureFiles, testCases } from '../schema.js';
import type { FeatureFile } from '../schema.js';

export interface IndexedScenarioInput {
  caseKey: string;
  name: string;
  line: number;
  tags: string[];
  contentHash: string;
  fingerprint: string;
  searchText: string;
}

export interface IndexFeatureFileInput {
  projectId: string;
  repo: string;
  path: string;
  blobSha: string | null;
  moduleKey: string | null;
  tags: string[];
  scenarios: IndexedScenarioInput[];
  parseStatus?: string;
  parseError?: string | null;
}

export interface FeatureIndexResult {
  featureFileId: string;
  active: number;
  obsolete: number;
}

export interface IndexedCase {
  id: string;
  caseKey: string;
  name: string;
  featurePath: string;
  moduleKey: string;
  tags: string[];
  fingerprint: string;
  status: 'active' | 'obsolete';
  line: number;
}

interface RawCaseRow {
  id: string;
  case_key: string;
  name: string;
  path: string;
  module_key: string | null;
  tags_json: string;
  fingerprint: string;
  status: string;
  line: number;
}

function parseTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

function toIndexedCase(row: RawCaseRow): IndexedCase {
  return {
    id: row.id,
    caseKey: row.case_key,
    name: row.name,
    featurePath: row.path,
    moduleKey: row.module_key ?? 'unknown',
    tags: parseTags(row.tags_json),
    fingerprint: row.fingerprint,
    status: row.status === 'obsolete' ? 'obsolete' : 'active',
    line: row.line,
  };
}

function searchTokensFor(query: string): string[] {
  return (
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map((token) => token.replace(/["']/g, ''))
      .filter((token) => token.length > 0)
      .slice(0, MAX_SEARCH_TOKENS) ?? []
  );
}

/** 多个关键词按 OR 组合，大小写不敏感；通配符已转义，按字面量匹配。 */
function searchConditions(tokens: readonly string[]): SQL | undefined {
  return or(
    ...tokens.map((token) =>
      or(
        containsToken(testCases.name, token),
        containsToken(testCases.searchText, token),
        containsToken(testCases.tagsJson, token),
      ),
    ),
  );
}

/**
 * Feature 与场景索引。Git 是事实源，本仓储只维护可重建的检索缓存；
 * search_text 由索引器随写随更，用于大小写不敏感的子串检索。
 */
export class FeatureIndexRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async indexFeatureFile(input: IndexFeatureFileInput): Promise<FeatureIndexResult> {
    const now = nowMs();

    return this.db.transaction(async (tx) => {
      const [existingFile] = await tx
        .select()
        .from(featureFiles)
        .where(
          and(
            eq(featureFiles.tenantId, this.tenantId),
            eq(featureFiles.projectId, input.projectId),
            eq(featureFiles.repo, input.repo),
            eq(featureFiles.path, input.path),
          ),
        )
        .limit(1);
      let featureFile: FeatureFile;

      if (existingFile === undefined) {
        const [inserted] = await tx
          .insert(featureFiles)
          .values({
            id: uuidv7(now),
            tenantId: this.tenantId,
            projectId: input.projectId,
            repo: input.repo,
            path: input.path,
            blobSha: input.blobSha,
            moduleKey: input.moduleKey,
            tagsJson: JSON.stringify(input.tags),
            scenarioCount: input.scenarios.length,
            parseStatus: input.parseStatus ?? 'parsed',
            parseError: input.parseError ?? null,
            indexedAt: now,
          })
          .returning();

        if (inserted === undefined) {
          throw new Error('Failed to insert feature file');
        }

        featureFile = inserted;
      } else {
        const [updated] = await tx
          .update(featureFiles)
          .set({
            blobSha: input.blobSha,
            moduleKey: input.moduleKey,
            tagsJson: JSON.stringify(input.tags),
            scenarioCount: input.scenarios.length,
            parseStatus: input.parseStatus ?? 'parsed',
            parseError: input.parseError ?? null,
            indexedAt: now,
          })
          .where(eq(featureFiles.id, existingFile.id))
          .returning();

        if (updated === undefined) {
          throw new Error('Failed to update feature file');
        }

        featureFile = updated;
      }

      const existingCases = await tx
        .select()
        .from(testCases)
        .where(eq(testCases.featureFileId, featureFile.id));
      const existingByKey = new Map(existingCases.map((item) => [item.caseKey, item]));
      const currentKeys = new Set(input.scenarios.map((scenario) => scenario.caseKey));

      for (const scenario of input.scenarios) {
        const existing = existingByKey.get(scenario.caseKey);

        if (existing === undefined) {
          await tx.insert(testCases).values({
            id: uuidv7(now),
            tenantId: this.tenantId,
            projectId: input.projectId,
            featureFileId: featureFile.id,
            caseKey: scenario.caseKey,
            name: scenario.name,
            line: scenario.line,
            tagsJson: JSON.stringify(scenario.tags),
            contentHash: scenario.contentHash,
            fingerprint: scenario.fingerprint,
            searchText: scenario.searchText,
            status: 'active',
            indexedAt: now,
          });
        } else {
          await tx
            .update(testCases)
            .set({
              name: scenario.name,
              line: scenario.line,
              tagsJson: JSON.stringify(scenario.tags),
              contentHash: scenario.contentHash,
              fingerprint: scenario.fingerprint,
              searchText: scenario.searchText,
              status: 'active',
              indexedAt: now,
            })
            .where(eq(testCases.id, existing.id));
        }
      }

      const obsoleteCases = existingCases.filter((item) => !currentKeys.has(item.caseKey));

      for (const obsolete of obsoleteCases) {
        await tx
          .update(testCases)
          .set({ status: 'obsolete', indexedAt: now })
          .where(eq(testCases.id, obsolete.id));
      }

      return {
        featureFileId: featureFile.id,
        active: input.scenarios.length,
        obsolete: obsoleteCases.length,
      };
    });
  }

  async listFeatureFiles(projectId: string, repo = 'suite'): Promise<FeatureFile[]> {
    return this.db
      .select()
      .from(featureFiles)
      .where(
        and(
          eq(featureFiles.tenantId, this.tenantId),
          eq(featureFiles.projectId, projectId),
          eq(featureFiles.repo, repo),
        ),
      )
      .orderBy(desc(featureFiles.indexedAt));
  }

  /** 文件从 Suite 消失时标记 missing，并将场景标记 obsolete，不物理删除。 */
  async markMissingFiles(projectId: string, repo: string, seenPaths: Set<string>): Promise<number> {
    const files = await this.listFeatureFiles(projectId, repo);
    let marked = 0;

    for (const file of files) {
      if (seenPaths.has(file.path) || file.parseStatus === 'missing') {
        continue;
      }

      await this.db
        .update(featureFiles)
        .set({ parseStatus: 'missing' })
        .where(eq(featureFiles.id, file.id));
      await this.db
        .update(testCases)
        .set({ status: 'obsolete', indexedAt: nowMs() })
        .where(eq(testCases.featureFileId, file.id));
      marked += 1;
    }

    return marked;
  }

  async listActiveCases(
    projectId: string,
    modules: readonly string[] = [],
  ): Promise<IndexedCase[]> {
    const conditions: SQL[] = [
      eq(testCases.tenantId, this.tenantId),
      eq(testCases.projectId, projectId),
      eq(testCases.status, 'active'),
    ];

    if (modules.length > 0) {
      conditions.push(inArray(featureFiles.moduleKey, [...modules]));
    }

    const rows = await this.db
      .select({
        id: testCases.id,
        case_key: testCases.caseKey,
        name: testCases.name,
        path: featureFiles.path,
        module_key: featureFiles.moduleKey,
        tags_json: testCases.tagsJson,
        fingerprint: testCases.fingerprint,
        status: testCases.status,
        line: testCases.line,
      })
      .from(testCases)
      .innerJoin(featureFiles, eq(testCases.featureFileId, featureFiles.id))
      .where(and(...conditions))
      .orderBy(desc(testCases.indexedAt));

    return rows.map(toIndexedCase);
  }

  async listObsoleteCases(projectId: string): Promise<IndexedCase[]> {
    const rows = await this.db
      .select({
        id: testCases.id,
        case_key: testCases.caseKey,
        name: testCases.name,
        path: featureFiles.path,
        module_key: featureFiles.moduleKey,
        tags_json: testCases.tagsJson,
        fingerprint: testCases.fingerprint,
        status: testCases.status,
        line: testCases.line,
      })
      .from(testCases)
      .innerJoin(featureFiles, eq(testCases.featureFileId, featureFiles.id))
      .where(
        and(
          eq(testCases.tenantId, this.tenantId),
          eq(testCases.projectId, projectId),
          eq(testCases.status, 'obsolete'),
        ),
      );

    return rows.map(toIndexedCase);
  }

  async searchCases(
    projectId: string,
    query: string,
    modules: readonly string[] = [],
    limit = 20,
  ): Promise<IndexedCase[]> {
    const tokens = searchTokensFor(query);

    if (tokens.length === 0) {
      return (await this.listActiveCases(projectId, modules)).slice(0, limit);
    }

    const conditions: SQL[] = [
      eq(testCases.tenantId, this.tenantId),
      eq(testCases.projectId, projectId),
      eq(testCases.status, 'active'),
    ];
    const tokenCondition = searchConditions(tokens);

    if (tokenCondition !== undefined) {
      conditions.push(tokenCondition);
    }

    if (modules.length > 0) {
      conditions.push(inArray(featureFiles.moduleKey, [...modules]));
    }

    const rows = await this.db
      .select({
        id: testCases.id,
        case_key: testCases.caseKey,
        name: testCases.name,
        path: featureFiles.path,
        module_key: featureFiles.moduleKey,
        tags_json: testCases.tagsJson,
        fingerprint: testCases.fingerprint,
        status: testCases.status,
        line: testCases.line,
      })
      .from(testCases)
      .innerJoin(featureFiles, eq(testCases.featureFileId, featureFiles.id))
      .where(and(...conditions))
      .orderBy(desc(testCases.indexedAt))
      .limit(Math.max(1, Math.min(limit, 100)));

    return rows.map(toIndexedCase);
  }
}
