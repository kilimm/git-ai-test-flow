// 本文件所有改动要求遵循 agent-rules 规范
import type { CoverageRelation, ExistingCase, FeaturePoint } from '@gait/shared';

export interface ExistingCaseRecord {
  id: string;
  caseKey: string;
  name: string;
  featurePath: string;
  moduleKey: string;
  tags: string[];
  fingerprint: string;
  status: 'active' | 'obsolete';
}

export interface CaseIndexPort {
  searchCases(
    projectId: string,
    query: string,
    modules: readonly string[],
    limit: number,
  ): ExistingCaseRecord[];
  listObsoleteCases(projectId: string): ExistingCaseRecord[];
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'when',
  'then',
  'should',
  'that',
  'this',
  'are',
  'was',
  'api',
  'new',
]);

export function tokenize(text: string): Set<string> {
  const tokens =
    text
      .toLowerCase()
      .match(/[a-z0-9_]+/g)
      ?.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)) ?? [];

  return new Set(tokens);
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) {
    if (right.has(token)) {
      return true;
    }
  }

  return false;
}

const COVERAGE_SEVERITY: Record<CoverageRelation, number> = {
  covered: 1,
  needs_update: 2,
  obsolete: 3,
  new: 0,
};

function worseCoverage(left: CoverageRelation, right: CoverageRelation): CoverageRelation {
  return COVERAGE_SEVERITY[right] > COVERAGE_SEVERITY[left] ? right : left;
}

function moduleMatches(record: ExistingCaseRecord, featurePoint: FeaturePoint): boolean {
  return featurePoint.affectedModules.includes(record.moduleKey);
}

function sourceReferenced(record: ExistingCaseRecord, featurePoint: FeaturePoint): boolean {
  const sourceTags = record.tags
    .filter((tag) => tag.startsWith('source:'))
    .map((tag) => tag.slice('source:'.length));

  return featurePoint.sources.some((source) =>
    sourceTags.some((tag) => tag === source.path || tag.endsWith(`/${source.path}`)),
  );
}

export function classifyCoverage(
  record: ExistingCaseRecord,
  featurePoint: FeaturePoint,
): CoverageRelation {
  const nameTokens = tokenize(record.name);
  const pointTokens = tokenize(`${featurePoint.title} ${featurePoint.description}`);
  const moduleMatch = moduleMatches(record, featurePoint);

  if (!moduleMatch && !overlaps(nameTokens, pointTokens)) {
    return 'new';
  }

  if (record.status === 'obsolete') {
    return 'obsolete';
  }

  if (sourceReferenced(record, featurePoint)) {
    return 'needs_update';
  }

  if (moduleMatch && overlaps(nameTokens, pointTokens)) {
    return 'covered';
  }

  return 'needs_update';
}

/**
 * 检索已有场景并标注覆盖关系。先按模块与关键词召回，再用
 * 源码 tag / 模块匹配 / 名称重叠做确定性判断；LLM 语义检索留待 P1。
 */
export function retrieveCasesForFeaturePoints(
  projectId: string,
  index: CaseIndexPort,
  featurePoints: readonly FeaturePoint[],
  limit = 40,
): ExistingCase[] {
  const selected = new Map<string, ExistingCase>();

  for (const featurePoint of featurePoints) {
    const records = index.searchCases(
      projectId,
      `${featurePoint.title} ${featurePoint.description}`,
      featurePoint.affectedModules,
      10,
    );

    for (const record of records) {
      const coverage = classifyCoverage(record, featurePoint);
      const existing = selected.get(record.id);
      const next: ExistingCase = {
        id: record.id,
        caseKey: record.caseKey,
        name: record.name,
        featurePath: record.featurePath,
        moduleKey: record.moduleKey,
        tags: record.tags,
        fingerprint: record.fingerprint,
        status: record.status,
        coverage: existing === undefined ? coverage : worseCoverage(existing.coverage, coverage),
      };
      selected.set(record.id, next);
    }
  }

  const modules = new Set(featurePoints.flatMap((featurePoint) => featurePoint.affectedModules));

  for (const record of index.listObsoleteCases(projectId)) {
    if (!modules.has(record.moduleKey) || selected.has(record.id)) {
      continue;
    }

    selected.set(record.id, {
      id: record.id,
      caseKey: record.caseKey,
      name: record.name,
      featurePath: record.featurePath,
      moduleKey: record.moduleKey,
      tags: record.tags,
      fingerprint: record.fingerprint,
      status: record.status,
      coverage: 'obsolete',
    });
  }

  return [...selected.values()].slice(0, limit);
}
