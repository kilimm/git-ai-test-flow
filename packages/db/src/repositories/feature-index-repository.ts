// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
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

function ftsQueryFor(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.map((token) => token.replace(/["']/g, ''))
    .filter((token) => token.length > 0)
    .slice(0, 8);

  if (tokens === undefined || tokens.length === 0) {
    return null;
  }

  return tokens.map((token) => `"${token}"`).join(' OR ');
}

/**
 * Feature 与场景索引。Git 是事实源，本仓储只维护可重建的检索缓存；
 * FTS5 表由迁移脚本创建，写入时与 test_cases 同步。
 */
export class FeatureIndexRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  indexFeatureFile(input: IndexFeatureFileInput): FeatureIndexResult {
    const now = nowMs();
    let featureFile = this.db
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
      .get();

    if (featureFile === undefined) {
      featureFile = this.db
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
        .returning()
        .get();
    } else {
      featureFile = this.db
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
        .where(eq(featureFiles.id, featureFile.id))
        .returning()
        .get();
    }

    const existingCases = this.db
      .select()
      .from(testCases)
      .where(eq(testCases.featureFileId, featureFile.id))
      .all();
    const existingByKey = new Map(existingCases.map((item) => [item.caseKey, item]));
    const currentKeys = new Set(input.scenarios.map((scenario) => scenario.caseKey));
    const activeIds: string[] = [];

    for (const scenario of input.scenarios) {
      const existing = existingByKey.get(scenario.caseKey);

      if (existing === undefined) {
        const inserted = this.db
          .insert(testCases)
          .values({
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
            status: 'active',
            indexedAt: now,
          })
          .returning({ id: testCases.id })
          .get();
        activeIds.push(inserted.id);
      } else {
        this.db
          .update(testCases)
          .set({
            name: scenario.name,
            line: scenario.line,
            tagsJson: JSON.stringify(scenario.tags),
            contentHash: scenario.contentHash,
            fingerprint: scenario.fingerprint,
            status: 'active',
            indexedAt: now,
          })
          .where(eq(testCases.id, existing.id))
          .run();
        activeIds.push(existing.id);
      }
    }

    const obsoleteCases = existingCases.filter((item) => !currentKeys.has(item.caseKey));

    for (const obsolete of obsoleteCases) {
      this.db
        .update(testCases)
        .set({ status: 'obsolete', indexedAt: now })
        .where(eq(testCases.id, obsolete.id))
        .run();
    }

    this.db.run(
      sql`DELETE FROM test_cases_fts WHERE case_id IN (SELECT id FROM test_cases WHERE feature_file_id = ${featureFile.id})`,
    );

    for (const [index, scenario] of input.scenarios.entries()) {
      const caseId = activeIds[index];

      if (caseId === undefined) {
        continue;
      }

      this.db.run(
        sql`INSERT INTO test_cases_fts (case_id, project_id, module_key, name, steps, tags)
            VALUES (${caseId}, ${input.projectId}, ${input.moduleKey ?? ''}, ${scenario.name}, ${scenario.searchText}, ${scenario.tags.join(' ')})`,
      );
    }

    return {
      featureFileId: featureFile.id,
      active: input.scenarios.length,
      obsolete: obsoleteCases.length,
    };
  }

  listFeatureFiles(projectId: string, repo = 'suite'): FeatureFile[] {
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
      .orderBy(desc(featureFiles.indexedAt))
      .all();
  }

  /** 文件从 Suite 消失时标记 missing，并将场景标记 obsolete，不物理删除。 */
  markMissingFiles(projectId: string, repo: string, seenPaths: Set<string>): number {
    const files = this.listFeatureFiles(projectId, repo);
    let marked = 0;

    for (const file of files) {
      if (seenPaths.has(file.path) || file.parseStatus === 'missing') {
        continue;
      }

      this.db
        .update(featureFiles)
        .set({ parseStatus: 'missing' })
        .where(eq(featureFiles.id, file.id))
        .run();
      this.db
        .update(testCases)
        .set({ status: 'obsolete', indexedAt: nowMs() })
        .where(eq(testCases.featureFileId, file.id))
        .run();
      this.db.run(
        sql`DELETE FROM test_cases_fts WHERE case_id IN (SELECT id FROM test_cases WHERE feature_file_id = ${file.id})`,
      );
      marked += 1;
    }

    return marked;
  }

  listActiveCases(projectId: string, modules: readonly string[] = []): IndexedCase[] {
    const conditions: SQL[] = [
      eq(testCases.tenantId, this.tenantId),
      eq(testCases.projectId, projectId),
      eq(testCases.status, 'active'),
    ];

    if (modules.length > 0) {
      conditions.push(inArray(featureFiles.moduleKey, [...modules]));
    }

    const rows = this.db
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
      .all();

    return rows.map(toIndexedCase);
  }

  listObsoleteCases(projectId: string): IndexedCase[] {
    const rows = this.db
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
      )
      .all();

    return rows.map(toIndexedCase);
  }

  searchCases(
    projectId: string,
    query: string,
    modules: readonly string[] = [],
    limit = 20,
  ): IndexedCase[] {
    const ftsQuery = ftsQueryFor(query);

    if (ftsQuery === null) {
      return this.listActiveCases(projectId, modules).slice(0, limit);
    }

    const moduleClause =
      modules.length === 0
        ? sql``
        : sql`AND ff.module_key IN (${sql.join(
            modules.map((module) => sql`${module}`),
            sql`, `,
          )})`;
    const rows = this.db.all<RawCaseRow>(sql`
      SELECT c.id AS id,
             c.case_key AS case_key,
             c.name AS name,
             ff.path AS path,
             ff.module_key AS module_key,
             c.tags_json AS tags_json,
             c.fingerprint AS fingerprint,
             c.status AS status,
             c.line AS line
      FROM test_cases_fts f
      JOIN test_cases c ON c.id = f.case_id
      JOIN feature_files ff ON ff.id = c.feature_file_id
      WHERE f.project_id = ${projectId}
        AND c.tenant_id = ${this.tenantId}
        AND c.project_id = ${projectId}
        AND c.status = 'active'
        AND test_cases_fts MATCH ${ftsQuery}
        ${moduleClause}
      ORDER BY bm25(test_cases_fts)
      LIMIT ${Math.max(1, Math.min(limit, 100))}
    `);

    return rows.map(toIndexedCase);
  }
}
