// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '@gait/config';
import {
  AuditLogWriter,
  CaseBlobRepository,
  FeatureIndexRepository,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, Project } from '@gait/db';
import { SuiteRepository } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { reindexSuite } from '@gait/agent';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CASE_STORAGE } from '@gait/shared';
import type { CaseStorage } from '@gait/shared';
import { isCaseBundlePath } from '@gait/runner';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

/** 迁移冲突处理策略：默认 skip（不覆盖），冲突项回报给调用方人工决定。 */
export const MIGRATION_CONFLICT_POLICIES = ['skip', 'overwrite'] as const;
export type MigrationConflictPolicy = (typeof MIGRATION_CONFLICT_POLICIES)[number];

export interface MigrateCasesInput {
  projectId: string;
  direction: 'repo_to_db' | 'db_to_repo';
  /** 只迁移这些路径；缺省迁移全部 feature 文件。 */
  paths?: string[] | undefined;
  conflictPolicy?: MigrationConflictPolicy | undefined;
}

export interface MigratedFile {
  path: string;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  reason?: string;
}

export interface MigrateCasesResult {
  direction: MigrateCasesInput['direction'];
  total: number;
  created: number;
  updated: number;
  skipped: number;
  unchanged: number;
  files: MigratedFile[];
  /** db_to_repo 时的提交 SHA；repo_to_db 时为来源 commit。 */
  commitSha: string | null;
}

function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 用例存储迁移（repo ⇄ db）。
 *
 * 设计约束：
 * - 迁移是**显式动作**，不做隐式双写，避免两边内容漂移后无法判定真相；
 * - 冲突默认 skip 并回报，不自动覆盖；
 * - 两个方向都写审计，便于追溯是谁在什么时候搬了用例。
 */
export class CaseMigrationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly auditWriter: AuditLogWriter,
    private readonly env: { DATA_DIR: string },
    private readonly gitAuth: GitAuth | null = null,
  ) {}

  private async project(context: AuthContext, projectId: string): Promise<Project> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);

    const project = await new ProjectRepository(this.db, context.tenant.id).findById(projectId);

    if (project === undefined) {
      throw new NotFoundError('Project not found');
    }

    return project;
  }

  private async openSuite(project: Project): Promise<SuiteRepository> {
    return await SuiteRepository.open({
      mode: project.suiteMode,
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      suiteRepoUrl: project.suiteRepoUrl,
      suitePath: project.suitePath,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir: this.env.DATA_DIR,
      headSha: 'HEAD',
      ...(this.gitAuth === null ? {} : { auth: this.gitAuth }),
    });
  }

  /** repo → db：把 Git 中的 feature 文件导入数据库。 */
  async repoToDb(context: AuthContext, input: MigrateCasesInput): Promise<MigrateCasesResult> {
    const project = await this.project(context, input.projectId);
    const policy = input.conflictPolicy ?? 'skip';
    const suite = await this.openSuite(project);

    try {
      // 资源（schemas/templates/fixtures）与 features 一起迁移：
      // DB 模式下 `JSON Schema "schemas/x.json"` 这类相对引用必须能在库里找到。
      const all = await suite.listCaseBundleFiles();
      const selected =
        input.paths === undefined
          ? all
          : all.filter((file) => input.paths?.includes(file.path) === true);
      const repository = new CaseBlobRepository(this.db, context.tenant.id);
      const existing = await repository.findPaths(
        project.id,
        selected.map((file) => file.path),
      );
      const files: MigratedFile[] = [];
      const toImport: {
        path: string;
        content: string;
        contentHash: string;
        origin: string;
      }[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let unchanged = 0;

      for (const file of selected) {
        const hash = contentHashOf(file.content);
        const current = existing.get(file.path);

        if (current !== undefined && current.contentHash === hash) {
          files.push({ path: file.path, action: 'unchanged' });
          unchanged += 1;
          continue;
        }

        if (current !== undefined && policy === 'skip') {
          files.push({
            path: file.path,
            action: 'skipped',
            reason: '路径已存在于数据库且内容不同；conflictPolicy=skip',
          });
          skipped += 1;
          continue;
        }

        toImport.push({
          path: file.path,
          content: file.content,
          contentHash: hash,
          origin: 'repo_import',
        });

        if (current === undefined) {
          files.push({ path: file.path, action: 'created' });
          created += 1;
        } else {
          files.push({ path: file.path, action: 'updated' });
          updated += 1;
        }
      }

      // 原子导入：要么全部写入，要么全部回滚，避免“一半新一半旧”的用例库。
      await repository.importMany(project.id, toImport, { updatedBy: context.user.id });

      await this.audit(context, project, 'repo_to_db', {
        total: selected.length,
        created,
        updated,
        skipped,
        unchanged,
      });

      return {
        direction: 'repo_to_db',
        total: selected.length,
        created,
        updated,
        skipped,
        unchanged,
        files,
        commitSha: null,
      };
    } finally {
      await suite.dispose();
    }
  }

  /** db → repo：把数据库中的用例提交到 Suite 仓库，并重建索引。 */
  async dbToRepo(context: AuthContext, input: MigrateCasesInput): Promise<MigrateCasesResult> {
    const project = await this.project(context, input.projectId);
    const policy = input.conflictPolicy ?? 'skip';
    const repository = new CaseBlobRepository(this.db, context.tenant.id);
    const rows = await repository.listByProject(project.id);
    const bundleRows = rows.filter((row) => isCaseBundlePath(row.path, project.featureRoot));
    const selected =
      input.paths === undefined
        ? bundleRows
        : bundleRows.filter((row) => input.paths?.includes(row.path) === true);

    if (selected.length === 0) {
      throw new ValidationError('数据库中没有可导出的用例文件');
    }

    const suite = await this.openSuite(project);

    try {
      const files: MigratedFile[] = [];
      const toWrite: { path: string; content: string }[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let unchanged = 0;

      for (const row of selected) {
        const current = suite.readFile(row.path);

        if (current === row.content) {
          files.push({ path: row.path, action: 'unchanged' });
          unchanged += 1;
          continue;
        }

        if (current !== null && policy === 'skip') {
          files.push({
            path: row.path,
            action: 'skipped',
            reason: '仓库中已存在该文件且内容不同；conflictPolicy=skip',
          });
          skipped += 1;
          continue;
        }

        toWrite.push({ path: row.path, content: row.content });

        if (current === null) {
          files.push({ path: row.path, action: 'created' });
          created += 1;
        } else {
          files.push({ path: row.path, action: 'updated' });
          updated += 1;
        }
      }

      let commitSha: string | null = null;

      if (toWrite.length > 0) {
        const commit = await suite.writeAndCommit(
          toWrite,
          `test: import cases from database (${toWrite.length} file(s))`,
        );

        commitSha = commit.commitSha;
      }

      // 仓库内容变化后重建索引，保持 DB 索引与仓库一致。
      await reindexSuite({
        suite,
        featureIndex: new FeatureIndexRepository(this.db, context.tenant.id),
        projectId: project.id,
      });

      await this.audit(context, project, 'db_to_repo', {
        total: selected.length,
        created,
        updated,
        skipped,
        unchanged,
        commitSha,
      });

      return {
        direction: 'db_to_repo',
        total: selected.length,
        created,
        updated,
        skipped,
        unchanged,
        files,
        commitSha,
      };
    } finally {
      await suite.dispose();
    }
  }

  /** 切换存储位置；切到 db 前要求库里已有用例，避免项目突然变成空用例集。 */
  async setCaseStorage(
    context: AuthContext,
    projectId: string,
    storage: CaseStorage,
  ): Promise<{ caseStorage: CaseStorage; caseFileCount: number }> {
    const project = await this.project(context, projectId);
    const repository = new CaseBlobRepository(this.db, context.tenant.id);
    const rows = await repository.listByProject(project.id);
    const bundleRows = rows.filter((row) => isCaseBundlePath(row.path, project.featureRoot));
    const featureRows = bundleRows.filter((row) => row.path.endsWith('.feature'));

    if (storage === CASE_STORAGE.DB && featureRows.length === 0) {
      throw new ConflictError(
        '数据库中没有用例文件，无法切换到 db 模式；请先执行 repo→db 迁移',
      );
    }

    // 切回 repo 前必须确认 DB 内容已全部导出：
    // 否则那些只存在于数据库的改动会静默失效（数据还在，但不再被执行）。
    if (storage === CASE_STORAGE.REPO && project.caseStorage === CASE_STORAGE.DB) {
      const pending = await this.pendingExportPaths(project, bundleRows);

      if (pending.length > 0) {
        throw new ConflictError(
          `数据库中有 ${pending.length} 个用例文件尚未导出到仓库（如 ${pending
            .slice(0, 3)
            .join(', ')}），请先执行 db→repo 迁移`,
        );
      }
    }

    await new ProjectRepository(this.db, context.tenant.id).update(project.id, {
      caseStorage: storage,
    });

    await this.audit(context, project, 'set_storage', { storage, fileCount: featureRows.length });

    return { caseStorage: storage, caseFileCount: featureRows.length };
  }

  private async audit(
    context: AuthContext,
    project: Project,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PROJECT_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
      resourceId: project.id,
      detail: { scope: 'case_storage', action, ...detail },
    });
  }

  /** 供 API 展示当前存储状态与两侧文件数。 */
  async caseStorageStatus(
    context: AuthContext,
    projectId: string,
  ): Promise<{
    caseStorage: CaseStorage;
    dbFiles: number;
    dbBundleFiles: number;
    repoFiles: number | null;
    pendingExport: number;
  }> {
    const project = await this.project(context, projectId);
    const rows = await new CaseBlobRepository(this.db, context.tenant.id).listByProject(project.id);
    const bundleRows = rows.filter((row) => isCaseBundlePath(row.path, project.featureRoot));

    return {
      caseStorage: project.caseStorage,
      dbFiles: bundleRows.filter((row) => row.path.endsWith('.feature')).length,
      dbBundleFiles: bundleRows.length,
      repoFiles: await this.countRepoFiles(project),
      pendingExport: (await this.pendingExportPaths(project, bundleRows)).length,
    };
  }

  /**
   * 数据库中与仓库内容不一致（或仓库缺失）的文件路径。
   * 用于「切回 repo 前的安全阀」以及状态展示。
   */
  private async pendingExportPaths(
    project: Project,
    rows: readonly { path: string; content: string }[],
  ): Promise<string[]> {
    if (rows.length === 0) {
      return [];
    }

    let suite: SuiteRepository;

    try {
      suite = await this.openSuite(project);
    } catch {
      // 仓库不可达时无法判定，保守返回空（不阻断切换，由调用方各自决定）。
      return [];
    }

    try {
      return rows
        .filter((row) => suite.readFile(row.path) !== row.content)
        .map((row) => row.path);
    } finally {
      await suite.dispose();
    }
  }

  /** 仓库不可达时返回 null，前端据此提示"仓库暂不可用"，不影响状态展示。 */
  private async countRepoFiles(project: Project): Promise<number | null> {
    try {
      const suite = await this.openSuite(project);

      try {
        return (await suite.listFeatureFiles()).length;
      } finally {
        await suite.dispose();
      }
    } catch {
      return null;
    }
  }
}
