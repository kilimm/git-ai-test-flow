// 本文件所有改动要求遵循 agent-rules 规范
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createS3ClientFromEnv } from '@gait/config';
import type { AppEnv, S3Client } from '@gait/config';
import { ArtifactRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import type { WorkerLogger } from './worker.js';

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 本地产物写 S3 副本：文件仍保留在 DATA_DIR，数据库 storage 改为 s3 并记录 s3Key。
 * 上传失败只记警告，不改变 Run 结果；Server 优先本地读取，缺失时回源 S3。
 */
export async function mirrorRunArtifacts(options: {
  db: AppDatabase;
  env: AppEnv;
  tenantId: string;
  runId: string;
  logger?: WorkerLogger;
  s3Client?: S3Client | null;
}): Promise<number> {
  if (options.env.ARTIFACT_STORAGE !== 's3') {
    return 0;
  }

  const s3 = options.s3Client ?? createS3ClientFromEnv(options.env);

  if (s3 === null) {
    options.logger?.warn?.(
      { tenantId: options.tenantId },
      'S3 storage selected but not configured',
    );
    return 0;
  }

  const repository = new ArtifactRepository(options.db, options.tenantId);
  const artifacts = await repository.listByRun(options.runId);
  const root = resolve(options.env.DATA_DIR, 'artifacts');
  let uploaded = 0;

  for (const artifact of artifacts) {
    if (artifact.storage === 's3') {
      continue;
    }

    const absolute = resolve(options.env.DATA_DIR, artifact.path);

    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      continue;
    }

    try {
      const body = readFileSync(absolute);
      const key = `${options.tenantId}/${options.runId}/${artifact.id}-${artifact.path
        .split('/')
        .pop()}`;
      await s3.putObject(key, body, artifact.mime);
      await repository.markStorage(artifact.id, 's3', {
        ...parseObject(artifact.metadataJson),
        s3Key: key,
      });
      uploaded += 1;
    } catch (error) {
      options.logger?.warn?.(
        {
          artifactId: artifact.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'S3 artifact mirror failed',
      );
    }
  }

  return uploaded;
}
