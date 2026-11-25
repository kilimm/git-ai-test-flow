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
import { reindexSuite } from '@gait/agent';
import { SuiteRepository } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { buildFeatureIndex, parseFeatureSource } from '@gait/runner';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CASE_STORAGE } from '@gait/shared';
import type { AuditAction } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface CaseAuthoringOptions {
  db: AppDatabase;
  auditWriter: AuditLogWriter;
  env: { DATA_DIR: string };
  gitAuth?: GitAuth | null;
}

export interface CaseFileDetail {
  path: string;
  content: string;
  /** repo：Git 中内容；db：暂无，null。 */
  committedContent: string | null;
  storage: 'repo' | 'db';
  existsInDb: boolean;
  pendingExport: boolean;
  moduleKey: string | null;
  scenarioCount: number;
  parseStatus: 'parsed' | 'invalid';
  parseError: string | null;
}

export interface CaseFileWriteResult {
  path: string;
  /** repo 模式提交 SHA；db 模式为 null。 */
  commitSha: string | null;
  scenarioCount: number;
  parseStatus: 'parsed' | 'invalid';
  parseError: string | null;
  moduleKey: string | null;
}

function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 用例 bundle 目录（与 SuiteRepository.listCaseBundleFiles 的根一致）。 */
const RESOURCE_DIRS = ['schemas', 'templates', 'fixtures'] as const;
const BUNDLE_EXTENSIONS = ['.feature', '.json', '.yaml', '.yml', '.md', '.mjs', '.js', '.sql', '.txt'];
/** 同步进 DB 索引/内容时用到的 feature 扩展名。 */
const FEATURE_EXT = '.feature';

const MODULE_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** 模块相关前端可选项。 */
export interface ModuleTreeNodeView {
  key: string;
  label: string;
  caseCount: number;
  children: ModuleTreeNodeView[];
}

export interface CaseAuthoringApi {
  getFile(context: AuthContext, projectId: string, path: string): Promise<CaseFileDetail>;
  saveFile(
    context: AuthContext,
    projectId: string,
    path: string,
    content: string,
  ): Promise<CaseFileWriteResult>;
  moveModule(
    context: AuthContext,
    projectId: string,
    path: string,
    moduleKey: string,
  ): Promise<{ path: string; from: string | null; to: string; touchedScenarios: number }>;
  editModules(
    context: AuthContext,
    projectId: string,
    operations: readonly ModuleOperation[],
  ): Promise<ModuleEditResult[]>;
  caseModuleTree(context: AuthContext, projectId: string): Promise<ModuleTreeNodeView[]>;
  listCasesInModule(
    context: AuthContext,
    projectId: string,
    moduleKey: string,
  ): Promise<{ path: string; caseKey: string; name: string; moduleKey: string }[]>;
  /** 单个模块的文件 + 用例聚合（一次请求，避免前端 N 次读文件）。 */
  moduleSnapshot(
    context: AuthContext,
    projectId: string,
    moduleKey: string,
  ): Promise<ModuleSnapshot>;
}

export interface ModuleOperation {
  type: 'rename' | 'delete';
  from: string;
  to?: string | undefined;
  /** delete 时：true=连带删除模块下用例；false=改为 unknown。 */
  deleteCases?: boolean | undefined;
}

export interface ModuleFileView {
  path: string;
  moduleKey: string | null;
  scenarioCount: number;
  parseStatus: string;
  parseError: string | null;
}

export interface ModuleSnapshot {
  moduleKey: string;
  files: ModuleFileView[];
  cases: { id: string; caseKey: string; name: string; featurePath: string; moduleKey: string; line: number }[];
  /** 同时返回全部模块树，前端可一次刷新（避免二次请求）。 */
  modules: ModuleTreeNodeView[];
}

export interface ModuleEditResult {
  operation: ModuleOperation;
  affectedFiles: string[];
  affectedScenarios: number;
}

/**
 * 用例在线编辑（读取/保存内容、改模块归属、模块增删改）。
 *
 * - 内容事实源按项目 caseStorage 决定：repo=Git、db=case_blobs；
 * - 保存后同步重建索引，保证列表页立即可见；
 * - 资源文件（schemas/templates/fixtures）也允许编辑，走同样的路径。
 */
export class CaseAuthoringService {
  private readonly db: AppDatabase;
  private readonly auditWriter: AuditLogWriter;
  private readonly env: { DATA_DIR: string };
  private readonly gitAuth: GitAuth | null;

  constructor(options: CaseAuthoringOptions) {
    this.db = options.db;
    this.auditWriter = options.auditWriter;
    this.env = options.env;
    this.gitAuth = options.gitAuth ?? null;
  }

  private blobs(context: AuthContext): CaseBlobRepository {
    return new CaseBlobRepository(this.db, context.tenant.id);
  }

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

  /** 该路径是否在可编辑范围内（feature 根或 bundle 资源目录）。 */
  private assertEditablePath(project: Project, path: string): void {
    if (path.length === 0 || path.startsWith('/') || path.includes('..')) {
      throw new ValidationError('非法用例路径');
    }

    const featureRoot = project.featureRoot.replace(/\/+$/, '');
    const extension = path.slice(path.lastIndexOf('.'));
    const inFeatureRoot = path.startsWith(`${featureRoot}/`);
    const inResourceRoot = RESOURCE_DIRS.some((dir) => path.startsWith(`${dir}/`) || path === dir);

    if (!inFeatureRoot && !inResourceRoot) {
      throw new ValidationError(`只能编辑 ${featureRoot}/ 与 ${RESOURCE_DIRS.join('/')} 下的文件`);
    }

    if (!BUNDLE_EXTENSIONS.includes(extension)) {
      throw new ValidationError(`不支持的用例文件类型：${extension || '(无扩展名)'}`);
    }
  }

  /** 读文件：返回当前生效内容（按 caseStorage）以及 repo/db 两侧状态。 */
  async getFile(context: AuthContext, projectId: string, path: string): Promise<CaseFileDetail> {
    const project = await this.project(context, projectId);
    this.assertEditablePath(project, path);

    const blob = await this.blobs(context).findByPath(project.id, path);
    let repoContent: string | null = null;

    try {
      const suite = await this.openSuite(project);

      try {
        repoContent = suite.readFile(path);
      } finally {
        await suite.dispose();
      }
    } catch {
      // 仓库不可达时不阻断读取；db 中若有内容仍可编辑。
    }

    const storage = project.caseStorage === CASE_STORAGE.DB ? 'db' : 'repo';
    const active = storage === 'db' ? (blob?.content ?? null) : repoContent;

    if (active === null) {
      throw new NotFoundError('用例文件不存在');
    }

    const pendingExport =
      storage === 'db' && blob !== null && repoContent === null
        ? true
        : blob !== null && repoContent !== null && blob.content !== repoContent;

    return {
      path,
      content: active,
      committedContent: storage === 'db' ? null : repoContent,
      storage,
      existsInDb: blob !== null,
      pendingExport,
      ...this.parseInfo(path, active),
    };
  }

  /** 保存文件：写 Git（repo）或 case_blobs（db），然后重建索引。 */
  async saveFile(
    context: AuthContext,
    projectId: string,
    path: string,
    content: string,
  ): Promise<CaseFileWriteResult> {
    const project = await this.project(context, projectId);
    this.assertEditablePath(project, path);

    if (content.trim().length === 0) {
      throw new ValidationError('用例内容不能为空');
    }

    const isFeature = path.endsWith(FEATURE_EXT);
    const parsed = isFeature ? this.parseInfo(path, content) : null;
    let commitSha: string | null = null;

    if (project.caseStorage === CASE_STORAGE.DB) {
      await this.blobs(context).put({
        projectId: project.id,
        path,
        content,
        contentHash: contentHashOf(content),
        origin: 'manual',
        updatedBy: context.user.id,
      });
    } else {
      const suite = await this.openSuite(project);

      try {
        const commit = await suite.writeAndCommit(
          [{ path, content }],
          `test: edit ${path} (manual)`,
        );
        commitSha = commit.commitSha;
      } finally {
        await suite.dispose();
      }
    }

    // feature 改动才需要重建索引；资源文件不参与索引。
    if (isFeature) {
      await this.reindex(context, project);
    }

    await this.audit(context, project, AUDIT_ACTION.CASE_EDIT, {
      path,
      length: content.length,
      commitSha,
    });

    const parseInfo = parsed ?? this.parseInfo(path, content);

    return {
      path,
      commitSha,
      scenarioCount: parseInfo.scenarioCount,
      parseStatus: parseInfo.parseStatus,
      parseError: parseInfo.parseError,
      moduleKey: parseInfo.moduleKey,
    };
  }

  /** 修改单个文件里全部场景的 module 标签，并保持作用域内文件路径一致。 */
  async moveModule(
    context: AuthContext,
    projectId: string,
    path: string,
    moduleKey: string,
  ): Promise<{ path: string; from: string | null; to: string; touchedScenarios: number }> {
    if (!MODULE_KEY_PATTERN.test(moduleKey)) {
      throw new ValidationError('模块 key 只能包含字母、数字、_ . -，且不能以符号开头');
    }

    const detail = await this.getFile(context, projectId, path);
    const project = await this.project(context, projectId);
    const featureRoot = project.featureRoot.replace(/\/+$/, '');

    // 文件归属模块由 feature 级 @module 决定（与 buildFeatureIndex 同口径）：
    // 补全/替换 feature 级标签，保证文件真正落到目标模块；场景级标签一并统一。
    const { content, touched, from } = rewriteModuleInFeature(
      detail.content,
      moduleKey,
      path.startsWith(`${featureRoot}/`),
    );

    if (touched === 0) {
      throw new ValidationError('该文件不是可解析的 feature，无法识别场景');
    }

    if (project.caseStorage === CASE_STORAGE.DB) {
      await this.blobs(context).put({
        projectId: project.id,
        path,
        content,
        contentHash: contentHashOf(content),
        origin: 'manual',
        updatedBy: context.user.id,
      });
    } else {
      const suite = await this.openSuite(project);

      try {
        await suite.writeAndCommit([{ path, content }], `test: move ${path} to module ${moduleKey}`);
      } finally {
        await suite.dispose();
      }
    }

    await this.reindex(context, project);
    await this.audit(context, project, AUDIT_ACTION.CASE_MOVE_MODULE, {
      path,
      from,
      to: moduleKey,
      scenarios: touched,
    });

    return { path, from, to: moduleKey, touchedScenarios: touched };
  }

  /**
   * 模块批量编辑：重命名 / 删除。
   * - rename：把所有 `module:<from>` 改写为 `module:<to>`，标签前缀精确匹配；
   * - delete：deleteCases=true 删除整个 feature 文件；否则把 module 标签改为 unknown。
   */
  async editModules(
    context: AuthContext,
    projectId: string,
    operations: readonly ModuleOperation[],
  ): Promise<ModuleEditResult[]> {
    const project = await this.project(context, projectId);
    const results: ModuleEditResult[] = [];

    for (const operation of operations) {
      const result = await this.applyModuleOperation(context, project, operation);
      results.push(result);
    }

    await this.reindex(context, project);

    return results;
  }

  private async applyModuleOperation(
    context: AuthContext,
    project: Project,
    operation: ModuleOperation,
  ): Promise<ModuleEditResult> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(operation.from)) {
      throw new ValidationError('非法模块 key');
    }

    const files = await this.listFeatureContents(context, project);
    const affectedFiles: string[] = [];
    const writes: { path: string; content: string }[] = [];
    const deletes: string[] = [];
    let affectedScenarios = 0;

    if (operation.type === 'rename') {
      const to = operation.to?.trim() ?? '';

      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(to)) {
        throw new ValidationError('目标模块 key 不合法');
      }

      if (to === operation.from) {
        throw new ValidationError('目标模块与源模块相同');
      }

      const targetTaken = files.some((file) =>
        [...file.moduleKeys].some((key) => key === to || key.startsWith(`${to}.`)),
      );

      if (targetTaken) {
        throw new ConflictError(`目标模块 ${to} 已存在`);
      }

      for (const file of files) {
        if (!file.moduleKeys.has(operation.from)) {
          continue;
        }

        const next = file.content.replace(/@module:([A-Za-z0-9_.-]+)/g, (match, key: string) =>
          key === operation.from || key.startsWith(`${operation.from}.`)
            ? `@module:${to}${key.slice(operation.from.length)}`
            : match,
        );

        if (next !== file.content) {
          writes.push({ path: file.path, content: next });
          affectedFiles.push(file.path);
          affectedScenarios += countScenarios(file.content);
        }
      }
    } else {
      for (const file of files) {
        if (!file.moduleKeys.has(operation.from)) {
          continue;
        }

        if (operation.deleteCases === true) {
          // 文件里全是该模块的场景才整文件删除；混合模块只删对应场景，避免误删别家用例。
          const onlyThisSubtree = [...file.moduleKeys].every(
            (key) => key === operation.from || key.startsWith(`${operation.from}.`),
          );

          if (onlyThisSubtree) {
            deletes.push(file.path);
            affectedFiles.push(file.path);
            affectedScenarios += countScenarios(file.content);
            continue;
          }

          const next = removeScenariosOfModule(file.content, operation.from);
          const removed = countScenarios(file.content) - countScenarios(next);
          writes.push({ path: file.path, content: next });
          affectedFiles.push(file.path);
          affectedScenarios += removed;
          continue;
        }

        // deleteCases=false：把该模块改到 unknown。
        const next = file.content.replace(/@module:([A-Za-z0-9_.-]+)/g, (match, key: string) =>
          key === operation.from || key.startsWith(`${operation.from}.`)
            ? '@module:unknown'
            : match,
        );
        writes.push({ path: file.path, content: next });
        affectedFiles.push(file.path);
        affectedScenarios += countScenarios(file.content);
      }
    }

    if (affectedFiles.length === 0) {
      throw new NotFoundError(`没有文件属于模块 ${operation.from}`);
    }

    if (project.caseStorage === CASE_STORAGE.DB) {
      const repository = this.blobs(context);

      for (const write of writes) {
        await repository.put({
          projectId: project.id,
          path: write.path,
          content: write.content,
          contentHash: contentHashOf(write.content),
          origin: 'manual',
          updatedBy: context.user.id,
        });
      }

      for (const path of deletes) {
        await repository.deleteByPath(project.id, path);
      }
    } else {
      const suite = await this.openSuite(project);

      try {
        if (writes.length > 0) {
          await suite.writeAndCommit(
            writes,
            `test: ${operation.type} module ${operation.from}`,
          );
        }

        if (deletes.length > 0) {
          await suite.deleteAndCommit(
            deletes,
            `test: delete module ${operation.from} (${deletes.length} file(s))`,
          );
        }
      } finally {
        await suite.dispose();
      }
    }

    await this.audit(
      context,
      project,
      operation.type === 'rename' ? AUDIT_ACTION.MODULE_RENAME : AUDIT_ACTION.MODULE_DELETE,
      {
        from: operation.from,
        to: operation.to ?? null,
        deleteCases: operation.deleteCases ?? null,
        files: affectedFiles,
      },
    );

    return { operation, affectedFiles, affectedScenarios };
  }

  /** 读取所有 feature 文件内容（按 caseStorage）。 */
  private async listFeatureContents(
    context: AuthContext,
    project: Project,
  ): Promise<{ path: string; content: string; moduleKeys: Set<string> }[]> {
    if (project.caseStorage === CASE_STORAGE.DB) {
      const rows = await this.blobs(context).listByProject(project.id);
      const featureRoot = project.featureRoot.replace(/\/+$/, '');

      return rows
        .filter((row) => row.path.startsWith(`${featureRoot}/`) && row.path.endsWith(FEATURE_EXT))
        .map((row) => ({
          path: row.path,
          content: row.content,
          moduleKeys: moduleKeysOf(row.content),
        }));
    }

    const suite = await this.openSuite(project);

    try {
      const files = await suite.listFeatureFiles();

      return files.map((file) => ({
        path: file.path,
        content: file.content,
        moduleKeys: moduleKeysOf(file.content),
      }));
    } finally {
      await suite.dispose();
    }
  }

  /** 读取某个模块（含子模块）下的全部用例，供前端便捷定位。 */
  async listCasesInModule(
    context: AuthContext,
    projectId: string,
    moduleKey: string,
  ): Promise<{ path: string; caseKey: string; name: string; moduleKey: string }[]> {
    const project = await this.project(context, projectId);
    const cases = await new FeatureIndexRepository(this.db, context.tenant.id).listActiveCases(
      project.id,
      [],
    );
    const prefix = moduleKey.length === 0 ? '' : `${moduleKey}.`;

    return cases
      .filter((item) => item.moduleKey === moduleKey || item.moduleKey.startsWith(prefix))
      .map((item) => ({
        path: item.featurePath,
        caseKey: item.caseKey,
        name: item.name,
        moduleKey: item.moduleKey,
      }));
  }

  /**
   * 单个模块的快照：文件（以文件实际 @module 归属为准）+ 用例（索引）。
   *
   * 性能要点：
   * - 只在 repo 模式打开一次 suite worktree，成批读取文件内容（而非每文件一次）；
   * - db 模式直接用 case_blobs 内容，不再逐个请求；
   * - 模块树与用例一次返回，前端无需再发 2-3 个请求。
   */
  async moduleSnapshot(
    context: AuthContext,
    projectId: string,
    moduleKey: string,
  ): Promise<ModuleSnapshot> {
    const project = await this.project(context, projectId);
    const index = new FeatureIndexRepository(this.db, context.tenant.id);
    const activeCases = await index.listActiveCases(project.id, []);
    const files = await this.featureContentsOf(context, project);
    const moduleFiles: ModuleFileView[] = [];

    for (const file of files) {
      const moduleOfFile = moduleKeysOf(file.content).values().next().value ?? null;

      if (!matchesModulePrefix(moduleOfFile, moduleKey)) {
        continue;
      }

      const parsed = this.parseInfo(file.path, file.content);

      moduleFiles.push({
        path: file.path,
        moduleKey: moduleOfFile,
        scenarioCount: parsed.scenarioCount,
        parseStatus: parsed.parseStatus,
        parseError: parsed.parseError,
      });
    }

    const pathsOfModule = new Set(moduleFiles.map((file) => file.path));

    return {
      moduleKey,
      files: moduleFiles,
      cases: activeCases
        .filter(
          (item) =>
            matchesModulePrefix(item.moduleKey, moduleKey) || pathsOfModule.has(item.featurePath),
        )
        .map((item) => ({
          id: item.id,
          caseKey: item.caseKey,
          name: item.name,
          featurePath: item.featurePath,
          moduleKey: item.moduleKey,
          line: item.line,
        })),
      modules: await this.moduleTree(context, project),
    };
  }

  /** 读取所有 feature 内容：repo 模式一次性打开 suite；db 模式读 case_blobs。 */
  private async featureContentsOf(
    context: AuthContext,
    project: Project,
  ): Promise<{ path: string; content: string }[]> {
    if (project.caseStorage === CASE_STORAGE.DB) {
      const featureRoot = project.featureRoot.replace(/\/+$/, '');
      const rows = await this.blobs(context).listByProject(project.id);

      return rows
        .filter((row) => row.path.startsWith(`${featureRoot}/`) && row.path.endsWith(FEATURE_EXT))
        .map((row) => ({ path: row.path, content: row.content }));
    }

    const suite = await this.openSuite(project);

    try {
      const files = await suite.listFeatureFiles();

      return files.map((file) => ({ path: file.path, content: file.content }));
    } finally {
      await suite.dispose();
    }
  }

  /** 按 module 前缀（含子模块）聚合出模块树，数量=cases。 */
  async caseModuleTree(context: AuthContext, projectId: string): Promise<ModuleTreeNodeView[]> {
    return await this.moduleTree(context, await this.project(context, projectId));
  }

  private async moduleTree(
    context: AuthContext,
    project: Project,
  ): Promise<ModuleTreeNodeView[]> {
    const index = new FeatureIndexRepository(this.db, context.tenant.id);
    const cases = await index.listActiveCases(project.id, []);
    const counts = new Map<string, number>();

    for (const item of cases) {
      const key = item.moduleKey.length === 0 ? 'unknown' : item.moduleKey;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const root: ModuleTreeNodeView[] = [];

    for (const [key, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      insertTree(root, key.split('.'), key, count);
    }

    return root;
  }

  private parseInfo(
    path: string,
    content: string,
  ): {
    moduleKey: string | null;
    scenarioCount: number;
    parseStatus: 'parsed' | 'invalid';
    parseError: string | null;
  } {
    if (!path.endsWith(FEATURE_EXT)) {
      return { moduleKey: null, scenarioCount: 0, parseStatus: 'parsed', parseError: null };
    }

    const parsed = parseFeatureSource(content);

    if (parsed.feature === null || parsed.errors.length > 0) {
      return {
        moduleKey: null,
        scenarioCount: 0,
        parseStatus: 'invalid',
        parseError: parsed.errors.map((error) => error.message).join('; '),
      };
    }

    const moduleKey = moduleKeysOf(content).values().next().value ?? null;

    return {
      moduleKey,
      scenarioCount: parsed.feature.scenarios.length,
      parseStatus: 'parsed',
      parseError: null,
    };
  }

  private async reindex(context: AuthContext, project: Project): Promise<void> {
    const featureIndex = new FeatureIndexRepository(this.db, context.tenant.id);

    if (project.caseStorage === CASE_STORAGE.DB) {
      // db 模式下用 case_blobs 的 feature 内容重建索引（suite 目录里可能是旧内容）。
      const rows = await this.blobs(context).listByProject(project.id);
      const featureRoot = project.featureRoot.replace(/\/+$/, '');
      const features = rows.filter(
        (row) => row.path.startsWith(`${featureRoot}/`) && row.path.endsWith(FEATURE_EXT),
      );

      for (const row of features) {
        // 复用 SuiteRepository 的索引构建逻辑口径：解析→写入索引。
        const suiteLike = buildFeatureIndexFromContent(project.id, row.path, row.content);
        await featureIndex.indexFeatureFile(suiteLike);
      }

      await featureIndex.markMissingFiles(
        project.id,
        'suite',
        new Set(features.map((row) => row.path)),
      );

      return;
    }

    const suite = await this.openSuite(project);

    try {
      await reindexSuite({ suite, featureIndex, projectId: project.id });
    } finally {
      await suite.dispose();
    }
  }

  private async audit(
    context: AuthContext,
    project: Project,
    action: AuditAction,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action,
      resourceType: AUDIT_RESOURCE_TYPE.TEST_CASE,
      resourceId: project.id,
      detail: { projectId: project.id, ...detail },
    });
  }
}

/** 模块前缀匹配：selected 命中自身与子模块；空 selected 表示全部。 */
function matchesModulePrefix(moduleKey: string | null, selected: string): boolean {
  if (selected.length === 0) {
    return true;
  }

  const key = moduleKey ?? 'unknown';

  return key === selected || key.startsWith(`${selected}.`);
}

/** 从文件内容里提取 module 标签集合（feature 级或场景级）。 */
function moduleKeysOf(content: string): Set<string> {
  const keys = new Set<string>();

  for (const match of content.matchAll(/@module:([A-Za-z0-9_.-]+)/g)) {
    const key = match[1];

    if (key !== undefined && key.length > 0) {
      keys.add(key);
    }
  }

  return keys;
}

function countScenarios(content: string): number {
  return content.split('\n').filter((line) => /^\s*(Scenario|Scenario Outline|场景|场景大纲):/.test(line))
    .length;
}

/**
 * 把全文件所有场景的 module 改成同一个值：
 * - 有场景级 @module 就替换；
 * - 否则在场景 tag 里补一个（若无 tag 行则插一行）。
 *
 * 注意：
 * - feature 级 @module 控制文件归属，不再改写（否则会被索引成 `<new>.<new>`）；
 * - 在同一 tag 行里逐个替换，不能用全局 replace（否则重复替换已改的标签）。
 */
function rewriteModuleInFeature(
  content: string,
  moduleKey: string,
  updateFeatureTag: boolean,
): { content: string; touched: number; from: string | null } {
  const lines = content.split('\n');
  const scenarioIndexes: number[] = [];
  let featureIndex = -1;

  lines.forEach((line, index) => {
    if (/^\s*(Feature|功能):/.test(line)) {
      featureIndex = index;
    }

    if (/^\s*(Scenario|Scenario Outline|场景|场景大纲):/.test(line)) {
      scenarioIndexes.push(index);
    }
  });

  const fromSet = moduleKeysOf(content);
  const from = fromSet.values().next().value ?? null;

  if (scenarioIndexes.length === 0) {
    return { content, touched: 0, from };
  }

  if (updateFeatureTag) {
    updateFeatureModuleTag(lines, featureIndex, moduleKey);
  }

  for (const scenarioIndex of scenarioIndexes) {
    let tagIndex = -1;

    // 找到紧邻场景、连续的 tag 块起始行。
    for (let cursor = scenarioIndex - 1; cursor >= 0; cursor -= 1) {
      const line = lines[cursor] ?? '';

      if (!line.trim().startsWith('@')) {
        break;
      }

      tagIndex = cursor;
    }

    if (tagIndex >= 0) {
      const tagLine = lines[tagIndex] ?? '';

      if (/@module:[A-Za-z0-9_.-]+/.test(tagLine)) {
        // 逐个替换（仅在本次替换后的结果里不再二次处理已改的标签）。
        lines[tagIndex] = tagLine.replace(/@module:[A-Za-z0-9_.-]+/, `@module:${moduleKey}`);
      } else {
        lines[tagIndex] = `${tagLine} @module:${moduleKey}`;
      }

      continue;
    }

    lines.splice(scenarioIndex, 0, `  @module:${moduleKey}`);
  }

  return { content: lines.join('\n'), touched: scenarioIndexes.length, from };
}

/**
 * 补全或替换 feature 级 @module 标签。
 * - Feature: 行的前一行为 tag 行且有 module → 替换；
 * - 否则在 Feature: 上一行插入 `@module:<key>`（touches=1）。
 */
function updateFeatureModuleTag(lines: string[], featureIndex: number, moduleKey: string): void {
  if (featureIndex < 0) {
    return;
  }

  const previousIndex = featureIndex - 1;
  const previous = previousIndex >= 0 ? (lines[previousIndex] ?? '') : '';

  if (previous.trim().startsWith('@') && /@module:[A-Za-z0-9_.-]+/.test(previous)) {
    lines[previousIndex] = previous.replace(/@module:[A-Za-z0-9_.-]+/, `@module:${moduleKey}`);

    return;
  }

  lines.splice(featureIndex, 0, `@module:${moduleKey}`);
}

/** 删除属于某模块的场景块（含其 tag 行与 steps），保留其他场景。 */
function removeScenariosOfModule(content: string, moduleKey: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let buffer: string[] = [];
  let bufferIsTarget = false;

  const flush = (): void => {
    if (!bufferIsTarget) {
      result.push(...buffer);
    }

    buffer = [];
    bufferIsTarget = false;
  };

  for (const line of lines) {
    if (/^\s*(Scenario|Scenario Outline|场景|场景大纲):/.test(line)) {
      flush();
      buffer = [line];
      // 回看上一个 entry 的 tag 行，若为目标模块则把它从 result 顶部移除并入 buffer。
      continue;
    }

    if (/^\s*(Feature|功能):/.test(line)) {
      flush();
      result.push(line);
      continue;
    }

    if (/^\s*@/.test(line) && buffer.length === 0) {
      bufferIsTarget = /@module:[A-Za-z0-9_-]+/.test(line) && line.includes(`@module:${moduleKey}`);
      buffer.push(line);
      continue;
    }

    if (buffer.length > 0) {
      buffer.push(line);

      if (/^\s*@module:/.test(line) && line.includes(`@module:${moduleKey}`)) {
        bufferIsTarget = true;
      }
    } else {
      result.push(line);
    }
  }

  flush();

  return result.join('\n');
}

function insertTree(
  nodes: ModuleTreeNodeView[],
  segments: readonly string[],
  fullKey: string,
  count: number,
): void {
  const [head, ...rest] = segments;

  if (head === undefined) {
    return;
  }

  let node = nodes.find((item) => item.key === head);

  if (node === undefined) {
    node = { key: head, label: head, caseCount: 0, children: [] };
    nodes.push(node);
  }

  if (rest.length === 0) {
    node.caseCount += count;

    return;
  }

  insertTree(node.children, rest, fullKey, count);
}

/** db 模式重建索引用：把单文件内容转成 IndexedFeatureFileInput。 */
function buildFeatureIndexFromContent(
  projectId: string,
  path: string,
  content: string,
): Parameters<FeatureIndexRepository['indexFeatureFile']>[0] {
  // 直接复用 runner 的 buildFeatureIndex，与 suite 模式同口径。
  const [input] = buildFeatureIndex(projectId, 'suite', [{ path, content, blobSha: null }]);

  if (input === undefined) {
    throw new Error('failed to build feature index');
  }

  return input;
}
