// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@gait/config';
import type { AppEnv, SecretCipher } from '@gait/config';
import {
  AuditLogWriter,
  CredentialRepository,
  DocRepository,
  JobQueue,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, Credential, DocModule, DocVersion, Project } from '@gait/db';
import { SuiteRepository } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { simplePatchDiff } from '@gait/agent';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  JOB_TYPE_DOC_SYNC,
  estimateTokens,
} from '@gait/shared';
import type {
  DocCommitEntryView,
  DocModuleStatus,
  DocModuleView,
  DocRollup,
  DocVersionView,
} from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface DocServiceOptions {
  db: AppDatabase;
  env: AppEnv;
  cipher: SecretCipher;
  auditWriter: AuditLogWriter;
  queue?: JobQueue;
  now?: () => number;
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function moduleView(module: DocModule): DocModuleView {
  return {
    id: module.id,
    key: module.key,
    name: module.name,
    description: module.description,
    owner: module.owner,
    pathPatterns: parseArray<string>(module.pathPatternsJson),
    dependsOn: parseArray<string>(module.dependsOnJson),
    status: module.status as DocModuleStatus,
    updatedAt: new Date(module.updatedAt).toISOString(),
  };
}

function versionView(version: DocVersion): DocVersionView {
  return {
    id: version.id,
    commitSha: version.commitSha,
    contentMd: version.contentMd,
    contentHash: version.contentHash,
    summary: version.summary,
    status: version.status as DocVersionView['status'],
    generated: version.generated,
    humanEdited: version.humanEdited,
    tokenCount: version.tokenCount,
    createdAt: new Date(version.createdAt).toISOString(),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 文档读取、手动压缩/重新同步、人工编辑与版本 diff。
 * 文档 Git 为事实源；数据库只做索引、版本与压缩缓存。
 */
export class DocService {
  private readonly db: AppDatabase;
  private readonly env: AppEnv;
  private readonly cipher: SecretCipher;
  private readonly auditWriter: AuditLogWriter;
  private readonly queue: JobQueue;
  private readonly now: () => number;

  constructor(options: DocServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.cipher = options.cipher;
    this.auditWriter = options.auditWriter;
    this.queue = options.queue ?? new JobQueue(options.db);
    this.now = options.now ?? (() => Date.now());
  }

  private project(context: AuthContext, projectId: string): Project {
    return requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
  }

  private repository(context: AuthContext): DocRepository {
    return new DocRepository(this.db, context.tenant.id);
  }

  listModules(context: AuthContext, projectId: string, query?: string): DocModuleView[] {
    this.project(context, projectId);
    const repository = this.repository(context);

    return (
      query === undefined || query.trim().length === 0
        ? repository.listModules(projectId)
        : repository.searchModules(projectId, query)
    ).map(moduleView);
  }

  getModule(
    context: AuthContext,
    id: string,
  ): {
    module: DocModuleView;
    version: DocVersionView | null;
  } {
    const module = this.repository(context).findModuleById(id);

    if (module === undefined) {
      throw new NotFoundError('Document module not found');
    }

    const latest = this.repository(context).latestVersion(module.id);

    return {
      module: moduleView(module),
      version: latest === undefined ? null : versionView(latest),
    };
  }

  listVersions(context: AuthContext, id: string, limit = 20): DocVersionView[] {
    const repository = this.repository(context);

    if (repository.findModuleById(id) === undefined) {
      throw new NotFoundError('Document module not found');
    }

    return repository.listVersions(id, limit).map(versionView);
  }

  listEntries(context: AuthContext, projectId: string, limit = 100): DocCommitEntryView[] {
    this.project(context, projectId);

    return this.repository(context)
      .listEntries(projectId, limit)
      .map((row) => ({
        id: row.id,
        commitSha: row.commitSha,
        committedAt: new Date(row.committedAt).toISOString(),
        author: row.author,
        title: row.title,
        summaryMd: row.summaryMd,
        modules: parseArray<string>(row.modulesJson),
        tokenCount: row.tokenCount,
      }));
  }

  diff(
    context: AuthContext,
    id: string,
    fromId: string,
    toId: string,
  ): { from: DocVersionView; to: DocVersionView; diff: string } {
    const repository = this.repository(context);
    const module = repository.findModuleById(id);
    const from = repository.findVersion(fromId);
    const to = repository.findVersion(toId);

    if (module === undefined || from === undefined || to === undefined) {
      throw new NotFoundError('Document version not found');
    }

    if (from.docModuleId !== module.id || to.docModuleId !== module.id) {
      throw new ValidationError('Document versions belong to a different module');
    }

    return {
      from: versionView(from),
      to: versionView(to),
      diff: simplePatchDiff(from.contentMd, to.contentMd, `${module.key}.md`),
    };
  }

  regenerate(context: AuthContext, projectId: string, headSha?: string): { jobId: string } {
    this.project(context, projectId);
    const job = this.queue.enqueue({
      type: JOB_TYPE_DOC_SYNC,
      payload: { projectId, mode: 'sync', ...(headSha === undefined ? {} : { headSha }) },
      tenantId: context.tenant.id,
      priority: 5,
      now: this.now(),
    });

    return { jobId: job.job.id };
  }

  compress(context: AuthContext, projectId: string): { jobId: string } {
    this.project(context, projectId);
    const job = this.queue.enqueue({
      type: JOB_TYPE_DOC_SYNC,
      payload: { projectId, mode: 'compress' },
      tenantId: context.tenant.id,
      priority: 4,
      now: this.now(),
    });

    return { jobId: job.job.id };
  }

  rollups(
    context: AuthContext,
    projectId: string,
  ): Array<DocRollup & { id: string; tier: string }> {
    this.project(context, projectId);

    return this.repository(context)
      .listRollups(projectId)
      .map((row) => ({
        id: row.id,
        tier: row.tier as DocRollup['tier'],
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        commitCount: row.commitCount,
        contentMd: row.contentMd,
        sourceShaRange: JSON.parse(row.sourceShaRange) as DocRollup['sourceShaRange'],
        sourceEntryIds: parseArray<string>(row.sourceEntryIdsJson),
        tokenCount: row.tokenCount,
      }));
  }

  async edit(context: AuthContext, id: string, content: string): Promise<DocVersionView> {
    const repository = this.repository(context);
    const module = repository.findModuleById(id);

    if (module === undefined) {
      throw new NotFoundError('Document module not found');
    }

    const project = this.project(context, module.projectId);
    const syncState = repository.getSyncState(project.id);
    const suite = await SuiteRepository.open({
      mode: project.suiteMode,
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      suiteRepoUrl: project.suiteRepoUrl,
      suitePath: project.suitePath,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir: this.env.DATA_DIR,
      headSha: syncState?.lastProcessedSha ?? null,
      auth: this.gitAuth(context, project),
    });
    const path = `${project.docsRoot.replace(/\/+$/, '')}/${module.key}.md`;

    try {
      suite.stageDocsFile(path, content);
      const commit = await suite.writeDocsAndCommit(
        [{ path, content }],
        `docs: manual edit ${module.key}`,
      );
      repository.markVersionsSuperseded(module.id, this.now());
      const version = repository.createVersion({
        projectId: project.id,
        docModuleId: module.id,
        commitSha: commit.commitSha,
        contentMd: content,
        contentHash: sha256(content),
        summary: '人工编辑',
        sourceRefs: [],
        generated: false,
        humanEdited: true,
        tokenCount: estimateTokens(content),
        status: 'committed',
        now: this.now(),
      });
      this.auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.DOC_EDIT,
        resourceType: AUDIT_RESOURCE_TYPE.DOC_MODULE,
        resourceId: module.id,
        detail: { commitSha: commit.commitSha, changed: commit.changed },
        now: this.now(),
      });

      return versionView(version);
    } finally {
      await suite.dispose();
    }
  }

  private gitAuth(context: AuthContext, project: Project): GitAuth | null {
    if (project.gitCredentialId === null) {
      return null;
    }

    const credential: Credential | undefined = new CredentialRepository(
      this.db,
      context.tenant.id,
    ).findById(project.gitCredentialId);

    if (credential === undefined || credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
      return null;
    }

    return {
      ...(credential.username === null ? {} : { username: credential.username }),
      token: this.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
        ciphertext: credential.secretCiphertext,
        iv: credential.secretIv,
        authTag: credential.secretAuthTag,
        keyVersion: credential.keyVersion,
      }),
    };
  }
}
