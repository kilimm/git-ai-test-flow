// 本文件所有改动要求遵循 agent-rules 规范
import { FeatureIndexRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, FeatureFile } from '@gait/db';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface CaseFileView {
  id: string;
  path: string;
  moduleKey: string | null;
  tags: string[];
  scenarioCount: number;
  parseStatus: string;
  parseError: string | null;
  /** true = 索引里有、但 Suite 仓库当前已不存在（历史上被删除/重命名）；不可编辑。 */
  missing: boolean;
  indexedAt: string;
}

export interface CaseView {
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

export interface CaseQuery {
  query?: string | undefined;
  module?: string | undefined;
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

function fileView(file: FeatureFile): CaseFileView {
  return {
    id: file.id,
    path: file.path,
    moduleKey: file.moduleKey,
    tags: parseTags(file.tagsJson),
    scenarioCount: file.scenarioCount,
    parseStatus: file.parseStatus,
    parseError: file.parseError,
    missing: file.parseStatus === 'missing',
    indexedAt: new Date(file.indexedAt).toISOString(),
  };
}

/** 用例索引只读查询；Git 仍是 Suite 的事实源，索引可重建。 */
export class CaseService {
  constructor(private readonly db: AppDatabase) {}

  private async requireProject(context: AuthContext, projectId: string): Promise<void> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
  }

  async listFiles(context: AuthContext, projectId: string): Promise<CaseFileView[]> {
    await this.requireProject(context, projectId);
    const files = await new FeatureIndexRepository(this.db, context.tenant.id).listFeatureFiles(
      projectId,
    );

    return files.map(fileView);
  }

  async listCases(context: AuthContext, projectId: string, query: CaseQuery): Promise<CaseView[]> {
    await this.requireProject(context, projectId);
    const repository = new FeatureIndexRepository(this.db, context.tenant.id);
    const modules = query.module === undefined ? [] : [query.module];
    const items =
      query.query === undefined || query.query.trim().length === 0
        ? await repository.listActiveCases(projectId, modules)
        : await repository.searchCases(projectId, query.query.trim(), modules, 100);

    return items.map((item) => ({
      id: item.id,
      caseKey: item.caseKey,
      name: item.name,
      featurePath: item.featurePath,
      moduleKey: item.moduleKey,
      tags: item.tags,
      fingerprint: item.fingerprint,
      status: item.status,
      line: item.line,
    }));
  }
}
