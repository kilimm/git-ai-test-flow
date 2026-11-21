// 本文件所有改动要求遵循 agent-rules 规范
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@gait/config';
import type { AuditLogWriter, RunnerNode } from '@gait/db';
import { RunnerNodeRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';

export interface RunnerView {
  id: string;
  name: string;
  capacity: number;
  status: 'online' | 'offline';
  version: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

export interface RunnerRegisterResult {
  runner: RunnerView;
  token: string;
}

export interface RunnerServiceOptions {
  db: AppDatabase;
  auditWriter: AuditLogWriter;
  now?: () => number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Runner 注册表：token 只显示一次，Worker 通过 RUNNER_NAME 匹配并写心跳。 */
export class RunnerService {
  private readonly db: AppDatabase;
  private readonly auditWriter: AuditLogWriter;
  private readonly now: () => number;
  private readonly repository: RunnerNodeRepository;

  constructor(options: RunnerServiceOptions) {
    this.db = options.db;
    this.auditWriter = options.auditWriter;
    this.now = options.now ?? (() => Date.now());
    this.repository = new RunnerNodeRepository(options.db);
  }

  private view(runner: RunnerNode): RunnerView {
    const now = this.now();
    const online = runner.lastHeartbeatAt !== null && now - runner.lastHeartbeatAt <= 60_000;

    return {
      id: runner.id,
      name: runner.name,
      capacity: runner.capacity,
      status: online ? 'online' : 'offline',
      version: runner.version,
      lastHeartbeatAt:
        runner.lastHeartbeatAt === null ? null : new Date(runner.lastHeartbeatAt).toISOString(),
      createdAt: new Date(runner.createdAt).toISOString(),
    };
  }

  list(context: AuthContext): RunnerView[] {
    this.assertAdmin(context);

    return this.repository.list().map((runner) => this.view(runner));
  }

  register(
    context: AuthContext,
    input: { name: string; capacity?: number | undefined },
  ): RunnerRegisterResult {
    this.assertAdmin(context);

    if (this.repository.findByName(input.name) !== undefined) {
      throw new ConflictError('Runner name already exists');
    }

    const token = `gait_run_${randomBytes(32).toString('base64url')}`;
    const runner = this.repository.register({
      name: input.name,
      tokenHash: hashToken(token),
      ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
      now: this.now(),
    });

    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.RUNNER_REGISTER,
      resourceType: AUDIT_RESOURCE_TYPE.RUNNER,
      resourceId: runner.id,
      detail: { name: runner.name, capacity: runner.capacity },
      now: this.now(),
    });

    return { runner: this.view(runner), token };
  }

  remove(context: AuthContext, id: string): void {
    this.assertAdmin(context);
    const runner = this.repository.findById(id);

    if (runner === undefined) {
      throw new NotFoundError('Runner not found');
    }

    this.repository.remove(id);
    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.RUNNER_REMOVE,
      resourceType: AUDIT_RESOURCE_TYPE.RUNNER,
      resourceId: id,
      detail: { name: runner.name },
      now: this.now(),
    });
  }

  /** 外部 Runner 心跳：Authorization: Bearer <注册 token>。 */
  heartbeat(token: string, input: { name: string; version?: string | undefined }): RunnerView {
    const repository = new RunnerNodeRepository(this.db);
    const all = repository.list();
    const match = all.find((runner) => runner.tokenHash === hashToken(token));

    if (match === undefined || match.name !== input.name) {
      throw new NotFoundError('Runner not found');
    }

    if (input.version !== undefined && input.version.length > 100) {
      throw new ValidationError('Runner version is too long');
    }

    const updated = repository.heartbeat(
      input.name,
      { version: input.version ?? match.version },
      this.now(),
    );

    if (updated === undefined) {
      throw new NotFoundError('Runner not found');
    }

    return this.view(updated);
  }

  private assertAdmin(context: AuthContext): void {
    if (!context.user.isPlatformAdmin) {
      throw new ForbiddenError('Platform administrator permission required');
    }
  }
}
