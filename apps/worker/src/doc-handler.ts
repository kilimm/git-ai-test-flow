// 本文件所有改动要求遵循 agent-rules 规范
import { createEncryptionKey, SecretCipher } from '@gait/config';
import type { AppEnv } from '@gait/config';
import { AuditLogWriter, CredentialRepository, DocRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, Credential, Project } from '@gait/db';
import {
  compressDocEntries,
  inferModules,
  parseModuleManifest,
  renderModuleManifest,
  syncProjectDocs,
} from '@gait/docs';
import type { DocSyncCommit } from '@gait/docs';
import { resolveCommit, runGit, syncMirror } from '@gait/git';
import type { GitAuth } from '@gait/git';
import { SuiteRepository } from '@gait/git';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE } from '@gait/shared';
import type { DocModuleDefinition } from '@gait/shared';
import type { JobHandler } from './job-handler.js';
import type { WorkerLogger } from './worker.js';

export interface DocHandlerOptions {
  db: AppDatabase;
  env: AppEnv;
  logger?: WorkerLogger;
  now?: () => number;
}

interface DocJobPayload {
  projectId: string;
  mode?: 'sync' | 'compress';
  headSha?: string;
  sinceSha?: string;
}

function parsePayload(payload: unknown): DocJobPayload {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as { projectId?: unknown }).projectId !== 'string'
  ) {
    throw new Error('doc.sync payload must contain projectId');
  }

  const record = payload as Record<string, unknown>;

  return {
    projectId: record['projectId'] as string,
    ...(record['mode'] === 'compress' ? { mode: 'compress' } : { mode: 'sync' }),
    ...(typeof record['headSha'] === 'string' ? { headSha: record['headSha'] } : {}),
    ...(typeof record['sinceSha'] === 'string' ? { sinceSha: record['sinceSha'] } : {}),
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,})/g, '****')
    .slice(0, 500);
}

export function createDocJobHandler(options: DocHandlerOptions): JobHandler {
  const { db, env } = options;
  const now = options.now ?? (() => Date.now());
  const cipher = new SecretCipher(
    createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION),
  );
  const audit = new AuditLogWriter(db);

  function decrypt(credential: Credential): string {
    return cipher.decrypt(credential.tenantId, credential.id, credential.type, {
      ciphertext: credential.secretCiphertext,
      iv: credential.secretIv,
      authTag: credential.secretAuthTag,
      keyVersion: credential.keyVersion,
    });
  }

  function gitAuth(tenantId: string, project: Project): GitAuth | null {
    if (project.gitCredentialId === null) {
      return null;
    }

    const credential = new CredentialRepository(db, tenantId).findById(project.gitCredentialId);

    if (credential === undefined || credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
      return null;
    }

    return {
      ...(credential.username === null ? {} : { username: credential.username }),
      token: decrypt(credential),
    };
  }

  async function collectCommits(
    mirrorPath: string,
    headSha: string,
    sinceSha: string | undefined,
    limit = 100,
  ): Promise<DocSyncCommit[]> {
    const range =
      sinceSha === undefined ? [headSha, `-n`, String(limit)] : [headSha, `^${sinceSha}`];
    const log = await runGit(['log', '--format=%H%x1f%an%x1f%ct%x1f%s%x1e', ...range], {
      cwd: mirrorPath,
      allowFailure: true,
    });
    const rows = log.stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .slice(0, limit);
    const commits: DocSyncCommit[] = [];

    for (const row of rows) {
      const [sha = '', author = '', timestamp = '0', title = ''] = row.split('\x1f');

      if (sha.length === 0) {
        continue;
      }

      const filesResult = await runGit(['show', '--name-only', '--format=', sha], {
        cwd: mirrorPath,
        allowFailure: true,
      });
      const patchResult = await runGit(['show', '--format=', '--unified=1', sha], {
        cwd: mirrorPath,
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
      });

      commits.push({
        sha,
        author,
        committedAt: Number(timestamp) * 1000,
        title,
        files: filesResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        patch: patchResult.stdout.slice(0, 200_000),
      });
    }

    return commits;
  }

  return async (context) => {
    const payload = parsePayload(context.payload);
    const tenantId = context.job.tenantId;

    if (tenantId === null) {
      throw new Error('doc.sync job is missing tenantId');
    }

    const repository = new DocRepository(db, tenantId);
    const project = new ProjectRepository(db, tenantId).findById(payload.projectId);

    if (project === undefined) {
      throw new Error('Document project not found');
    }

    if (payload.mode === 'compress') {
      const entries = repository.listAllEntries(project.id).map((row) => ({
        commitSha: row.commitSha,
        committedAt: row.committedAt,
        author: row.author,
        title: row.title,
        summaryMd: row.summaryMd,
        detailMd: row.detailMd,
        files: JSON.parse(row.filesJson) as string[],
        modules: JSON.parse(row.modulesJson) as string[],
        tokenCount: row.tokenCount,
      }));
      const rollups = compressDocEntries(entries);
      repository.replaceRollups(
        project.id,
        rollups.map((rollup) => ({ ...rollup, projectId: project.id })),
        now(),
      );
      audit.append({
        tenantId,
        action: AUDIT_ACTION.DOC_COMPRESS,
        resourceType: AUDIT_RESOURCE_TYPE.DOC_MODULE,
        resourceId: project.id,
        detail: { entries: entries.length, rollups: rollups.length },
        now: now(),
      });

      return;
    }

    const auth = gitAuth(tenantId, project);
    const mirrorPath = `${env.DATA_DIR}/git/mirrors/product-${project.id}.git`;

    await syncMirror({
      repoUrl: project.productRepoUrl,
      mirrorPath,
      ...(auth === null ? {} : { auth }),
      signal: context.signal,
    });
    const headSha =
      payload.headSha ??
      (await resolveCommit(mirrorPath, project.defaultBranch, {
        ...(auth === null ? {} : { auth }),
      }));
    const tree = await runGit(['ls-tree', '-r', '--name-only', headSha], {
      cwd: mirrorPath,
      signal: context.signal,
    });
    const repoFiles = tree.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const manifestPath = `${project.docsRoot.replace(/\/+$/, '')}/modules.yaml`;
    const manifestResult = await runGit(['show', `${headSha}:${manifestPath}`], {
      cwd: mirrorPath,
      allowFailure: true,
    });
    let manifest: DocModuleDefinition[] | null = null;

    if (manifestResult.exitCode === 0 && manifestResult.stdout.trim().length > 0) {
      try {
        manifest = parseModuleManifest(manifestResult.stdout).modules;
      } catch (error) {
        options.logger?.warn?.(
          { projectId: project.id, error: safeError(error) },
          'invalid module manifest',
        );
      }
    }

    const sinceSha =
      payload.sinceSha ?? repository.getSyncState(project.id)?.lastProcessedSha ?? undefined;
    const commits = await collectCommits(mirrorPath, headSha, sinceSha);
    const modules =
      manifest ?? inferModules([...repoFiles, ...commits.flatMap((commit) => commit.files)]);
    const suite = await SuiteRepository.open({
      mode: project.suiteMode,
      projectId: project.id,
      projectSlug: project.slug,
      projectRepoUrl: project.productRepoUrl,
      suiteRepoUrl: project.suiteRepoUrl,
      suitePath: project.suitePath,
      featureRoot: project.featureRoot,
      docsRoot: project.docsRoot,
      dataDir: env.DATA_DIR,
      headSha,
      auth,
      signal: context.signal,
    });

    try {
      const staged = new Map<string, string>();
      const result = await syncProjectDocs({
        db,
        tenantId,
        project,
        headSha,
        commits,
        repoFiles,
        moduleManifest: manifest,
        now: now(),
        writeDoc: (path, content) => {
          staged.set(path, content);

          return true;
        },
      });

      // 首次接入写入候选 modules.yaml，供人工确认后作为稳定映射。
      if (manifest === null) {
        staged.set(manifestPath, renderModuleManifest(modules));
      }

      for (const [path, content] of staged) {
        suite.stageDocsFile(path, content);
      }

      const commit = await suite.writeDocsAndCommit(
        [...staged.entries()].map(([path, content]) => ({ path, content })),
        `docs: sync AI module docs for ${headSha.slice(0, 12)}`,
      );

      repository.updateSyncState(
        project.id,
        { lastProcessedSha: headSha, lastDocCommitSha: commit.commitSha },
        now(),
      );
      audit.append({
        tenantId,
        action: AUDIT_ACTION.DOC_SYNC,
        resourceType: AUDIT_RESOURCE_TYPE.DOC_MODULE,
        resourceId: project.id,
        detail: {
          headSha,
          modules: result.modules.length,
          entries: result.entries.length,
          rollups: result.rollups.length,
          conflicts: result.conflicts,
          commitSha: commit.commitSha,
        },
        now: now(),
      });
    } finally {
      await suite.dispose();
    }
  };
}
