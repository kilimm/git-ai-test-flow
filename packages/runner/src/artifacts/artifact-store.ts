// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { uuidv7 } from '@gait/config';
import type { ArtifactRepository } from '@gait/db';
import type { Artifact } from '@gait/db';
import { ensureDirectory } from '@gait/git';
import { ARTIFACT_RETENTION_DAYS } from '@gait/shared';
import type { ArtifactType } from '@gait/shared';
import { truncateText } from './redaction.js';

export interface ArtifactWriteInput {
  type: ArtifactType;
  name: string;
  data: string | Buffer;
  mime: string;
  redacted?: boolean;
  metadata?: unknown;
}

export interface StoredArtifact {
  id: string;
  type: ArtifactType;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  expiresAt: number | null;
  /** 可直接返回给 API 的相对数据目录路径。 */
  dataRelativePath: string;
}

export interface ArtifactStoreOptions {
  dataDir: string;
  tenantId: string;
  runId: string;
  repository?: ArtifactRepository;
  now?: () => number;
}

interface Scope {
  runCaseId: string | null;
  stepResultId: string | null;
}

function safeName(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return cleaned.length === 0 ? 'artifact' : cleaned;
}

function extensionOf(mime: string): string {
  if (mime.includes('json')) {
    return 'json';
  }

  if (mime.includes('html')) {
    return 'html';
  }

  if (mime.includes('markdown')) {
    return 'md';
  }

  if (mime.includes('xml')) {
    return 'xml';
  }

  if (mime.includes('png')) {
    return 'png';
  }

  if (mime.includes('jpeg')) {
    return 'jpg';
  }

  if (mime.includes('zip')) {
    return 'zip';
  }

  if (mime.includes('text')) {
    return 'txt';
  }

  return 'bin';
}

/**
 * 产物落盘与索引：
 * - 文件位于 DATA_DIR/artifacts/<tenant>/<run>/<case>/，数据库只保存相对路径；
 * - 自动计算 SHA-256、大小与过期时间；
 * - 内容由调用方决定是否脱敏，API/DB 产物默认已脱敏。
 */
export class ArtifactStore {
  private readonly options: ArtifactStoreOptions;
  private readonly scope: Scope;

  constructor(
    options: ArtifactStoreOptions,
    scope: Scope = { runCaseId: null, stepResultId: null },
  ) {
    this.options = options;
    this.scope = scope;
  }

  withScope(scope: Partial<Scope>): ArtifactStore {
    return new ArtifactStore(this.options, {
      runCaseId: scope.runCaseId ?? this.scope.runCaseId,
      stepResultId: scope.stepResultId ?? this.scope.stepResultId,
    });
  }

  private async write(input: ArtifactWriteInput): Promise<StoredArtifact> {
    const now = this.options.now?.() ?? Date.now();
    const buffer = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(
          truncateText(typeof input.data === 'string' ? input.data : String(input.data)),
          'utf8',
        );
    const id = uuidv7(now);
    const directory = join(
      this.options.dataDir,
      'artifacts',
      safeName(this.options.tenantId),
      safeName(this.options.runId),
      safeName(this.scope.runCaseId ?? 'run'),
    );
    const fileName = `${id}-${safeName(input.name)}.${extensionOf(input.mime)}`;
    const absolutePath = join(directory, fileName);
    const relativePath = relative(this.options.dataDir, absolutePath).split(sep).join('/');
    const dataRelativePath = relative(join(this.options.dataDir, 'artifacts'), absolutePath)
      .split(sep)
      .join('/');

    ensureDirectory(directory);
    writeFileSync(absolutePath, buffer);

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const days = ARTIFACT_RETENTION_DAYS[input.type];
    const expiresAt = now + days * 24 * 60 * 60 * 1_000;

    const row =
      this.options.repository === undefined
        ? undefined
        : await this.options.repository.create({
            runId: this.options.runId,
            runCaseId: this.scope.runCaseId,
            stepResultId: this.scope.stepResultId,
            type: input.type,
            path: relativePath,
            mime: input.mime,
            size: buffer.byteLength,
            sha256,
            redacted: input.redacted ?? true,
            expiresAt,
            metadata: input.metadata ?? {},
          });

    return {
      id: row?.id ?? id,
      type: input.type,
      path: relativePath,
      mime: input.mime,
      size: buffer.byteLength,
      sha256,
      expiresAt,
      dataRelativePath,
    };
  }

  async writeText(
    type: ArtifactType,
    name: string,
    text: string,
    mime = 'text/plain; charset=utf-8',
    metadata?: unknown,
  ): Promise<StoredArtifact> {
    return this.write({ type, name, data: text, mime, redacted: true, metadata });
  }

  async writeJson(
    type: ArtifactType,
    name: string,
    value: unknown,
    metadata?: unknown,
  ): Promise<StoredArtifact> {
    return this.write({
      type,
      name,
      data: JSON.stringify(value, null, 2),
      mime: 'application/json',
      redacted: true,
      metadata,
    });
  }

  async writeBuffer(
    type: ArtifactType,
    name: string,
    buffer: Buffer,
    mime: string,
    metadata?: unknown,
  ): Promise<StoredArtifact> {
    return this.write({ type, name, data: buffer, mime, redacted: false, metadata });
  }
}

export type { Artifact };
