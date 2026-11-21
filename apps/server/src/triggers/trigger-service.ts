// 本文件所有改动要求遵循 agent-rules 规范
import { createHash, randomBytes } from 'node:crypto';
import { AppError, NotFoundError, ValidationError } from '@gait/config';
import type { AppDatabase, AuditLogWriter, Project, TriggerConfig } from '@gait/db';
import {
  EnvironmentRepository,
  ProjectRepository,
  TriggerGlobalRepository,
  TriggerRepository,
} from '@gait/db';
import { TriggerEngine } from '@gait/agent';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  TRIGGER_TOKEN_PREFIX,
  WEBHOOK_ERROR,
  normalizeRunSelection,
} from '@gait/shared';
import type {
  RunSelection,
  TriggerAction,
  TriggerConfigView,
  TriggerCreateResult,
  TriggerType,
} from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import { requireProject } from '../projects/support.js';

export interface CreateTriggerServiceInput {
  name: string;
  type: TriggerType;
  action: TriggerAction;
  enabled?: boolean | undefined;
  cron?: string | undefined;
  branch?: string | undefined;
  environmentId?: string | undefined;
  selection?:
    | {
        type?: string | undefined;
        modules?: string[] | undefined;
        caseKeys?: string[] | undefined;
      }
    | undefined;
}

export interface UpdateTriggerServiceInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  cron?: string | null | undefined;
  branch?: string | null | undefined;
  environmentId?: string | null | undefined;
  selection?:
    | {
        type?: string | undefined;
        modules?: string[] | undefined;
        caseKeys?: string[] | undefined;
      }
    | undefined;
}

export interface TriggerFireWebhookResult {
  kind: 'run' | 'generation' | 'skipped';
  id: string | null;
  created: boolean;
  reason: string | null;
}

export interface TriggerServiceOptions {
  db: AppDatabase;
  auditWriter: AuditLogWriter;
  engine?: TriggerEngine;
  now?: () => number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return `${TRIGGER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

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

function selectionFrom(json: string): RunSelection {
  const raw = parseObject(json);

  return normalizeRunSelection({
    type: typeof raw.type === 'string' ? raw.type : 'all',
    modules: Array.isArray(raw.modules)
      ? raw.modules.filter((item): item is string => typeof item === 'string')
      : [],
    caseKeys: Array.isArray(raw.caseKeys)
      ? raw.caseKeys.filter((item): item is string => typeof item === 'string')
      : [],
  });
}

function view(trigger: TriggerConfig): TriggerConfigView {
  return {
    id: trigger.id,
    projectId: trigger.projectId,
    name: trigger.name,
    type: trigger.type,
    action: trigger.action,
    enabled: trigger.enabled,
    cron: trigger.cron,
    branch: trigger.branch,
    environmentId: trigger.environmentId,
    selection: selectionFrom(trigger.selectionJson),
    lastFiredAt: trigger.lastFiredAt === null ? null : new Date(trigger.lastFiredAt).toISOString(),
    nextRunAt: trigger.nextRunAt === null ? null : new Date(trigger.nextRunAt).toISOString(),
    createdAt: new Date(trigger.createdAt).toISOString(),
    updatedAt: new Date(trigger.updatedAt).toISOString(),
  };
}

function parseWebhookPayload(
  type: 'git_webhook' | 'deployment',
  payload: unknown,
): { headSha: string; branch: string | null } {
  const body =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  if (type === 'deployment') {
    const headSha =
      typeof body.headSha === 'string'
        ? body.headSha
        : typeof body.deployedSha === 'string'
          ? body.deployedSha
          : null;

    if (headSha === null || !/^[0-9a-f]{7,64}$/i.test(headSha)) {
      throw new AppError('deployedSha is required', {
        status: 400,
        code: WEBHOOK_ERROR.DEPLOYED_SHA_MISSING,
      });
    }

    return {
      headSha,
      branch: typeof body.branch === 'string' ? body.branch : null,
    };
  }

  const gitlab = body.object_kind !== undefined;
  const headSha = gitlab
    ? ((body.checkout_sha as string | undefined) ??
      (body.object_attributes as { last_commit?: { id?: string } } | undefined)?.last_commit?.id ??
      null)
    : typeof body.after === 'string'
      ? body.after
      : null;

  if (headSha === null || !/^[0-9a-f]{7,64}$/i.test(headSha)) {
    throw new AppError('Webhook did not contain a commit SHA', {
      status: 400,
      code: WEBHOOK_ERROR.PAYLOAD_INVALID,
    });
  }

  const ref = typeof body.ref === 'string' ? body.ref : null;
  const gitlabRef = gitlab
    ? ((body.object_attributes as { ref?: string } | undefined)?.ref ?? null)
    : null;

  return {
    headSha,
    branch: (ref ?? gitlabRef)?.replace(/^refs\/heads\//, '') ?? null,
  };
}

/** 触发器 CRUD 与公开 Webhook/部署回调；平台只负责入队，不执行产品代码。 */
export class TriggerService {
  private readonly db: AppDatabase;
  private readonly auditWriter: AuditLogWriter;
  private readonly engine: TriggerEngine;
  private readonly now: () => number;

  constructor(options: TriggerServiceOptions) {
    this.db = options.db;
    this.auditWriter = options.auditWriter;
    this.engine =
      options.engine ??
      new TriggerEngine({
        db: options.db,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.now = options.now ?? (() => Date.now());
  }

  private project(context: AuthContext, projectId: string): Project {
    return requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
  }

  private repository(context: AuthContext): TriggerRepository {
    return new TriggerRepository(this.db, context.tenant.id);
  }

  list(context: AuthContext, projectId: string): TriggerConfigView[] {
    this.project(context, projectId);

    return this.repository(context).listByProject(projectId).map(view);
  }

  create(
    context: AuthContext,
    projectId: string,
    input: CreateTriggerServiceInput,
  ): TriggerCreateResult {
    this.project(context, projectId);

    if (input.type !== 'schedule' && input.action !== 'run' && input.type === 'deployment') {
      throw new ValidationError('Deployment triggers must use action=run');
    }

    if (input.environmentId !== undefined) {
      const environment = new EnvironmentRepository(this.db, context.tenant.id).findById(
        input.environmentId,
      );

      if (environment === undefined || environment.projectId !== projectId) {
        throw new ValidationError('Trigger environment does not belong to this project');
      }
    }

    const needsToken = input.type !== 'schedule';
    const token = needsToken ? newToken() : null;
    const now = this.now();
    const nextRunAt =
      input.type === 'schedule' && input.cron !== undefined
        ? this.engine.nextRunAt(input.cron, new Date(now))
        : null;

    if (input.type === 'schedule' && nextRunAt === null) {
      throw new ValidationError('Cron expression has no future occurrence');
    }

    const trigger = this.repository(context).create({
      projectId,
      name: input.name,
      type: input.type,
      action: input.action,
      enabled: input.enabled ?? true,
      cron: input.cron ?? null,
      branch: input.branch ?? null,
      environmentId: input.environmentId ?? null,
      selection: normalizeRunSelection(input.selection),
      tokenHash: token === null ? null : hashToken(token),
      nextRunAt,
      now,
    });

    this.audit(context, AUDIT_ACTION.TRIGGER_CREATE, trigger.id, {
      projectId,
      type: input.type,
      action: input.action,
      cron: input.cron ?? null,
    });

    return { trigger: view(trigger), token };
  }

  update(
    context: AuthContext,
    projectId: string,
    triggerId: string,
    input: UpdateTriggerServiceInput,
    rotateToken = false,
  ): TriggerCreateResult {
    const repository = this.repository(context);
    const existing = repository.findById(triggerId);

    if (existing === undefined || existing.projectId !== projectId) {
      throw new NotFoundError('Trigger not found');
    }

    if (input.environmentId !== undefined && input.environmentId !== null) {
      const environment = new EnvironmentRepository(this.db, context.tenant.id).findById(
        input.environmentId,
      );

      if (environment === undefined || environment.projectId !== projectId) {
        throw new ValidationError('Trigger environment does not belong to this project');
      }
    }

    const token = rotateToken ? newToken() : null;
    const now = this.now();
    const cron = input.cron === undefined ? existing.cron : input.cron;

    if (existing.type === 'schedule') {
      if (cron === null || cron === undefined) {
        throw new ValidationError('Schedule triggers require cron');
      }

      if (this.engine.nextRunAt(cron, new Date(now)) === null) {
        throw new ValidationError('Cron expression has no future occurrence');
      }
    }

    const updated = repository.update(
      triggerId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.cron === undefined ? {} : { cron: input.cron }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
        ...(input.selection === undefined
          ? {}
          : { selection: normalizeRunSelection(input.selection) }),
        ...(token === null ? {} : { tokenHash: hashToken(token) }),
        ...(existing.type === 'schedule'
          ? { nextRunAt: this.engine.nextRunAt(cron, new Date(now)) }
          : {}),
      },
      now,
    );

    if (updated === undefined) {
      throw new NotFoundError('Trigger not found');
    }

    this.audit(context, AUDIT_ACTION.TRIGGER_UPDATE, triggerId, {
      projectId: existing.projectId,
      rotateToken,
    });

    return { trigger: view(updated), token };
  }

  remove(context: AuthContext, projectId: string, triggerId: string): void {
    const trigger = this.repository(context).findById(triggerId);

    if (trigger === undefined || trigger.projectId !== projectId) {
      throw new NotFoundError('Trigger not found');
    }

    this.repository(context).remove(triggerId);
    this.audit(context, AUDIT_ACTION.TRIGGER_DELETE, triggerId, {
      projectId: trigger.projectId,
    });
  }

  /** 公开 Webhook：按 projectId + token hash 查找，不返回资源存在性差异。 */
  fireWebhook(input: {
    projectId: string;
    token: string;
    type: 'git_webhook' | 'deployment';
    payload: unknown;
    actorUserId?: string | null;
  }): TriggerFireWebhookResult {
    const trigger = new TriggerGlobalRepository(this.db).findByTokenHash(
      input.projectId,
      hashToken(input.token),
    );

    if (trigger === undefined || trigger.type !== input.type) {
      throw new AppError('Webhook token is invalid', {
        status: 401,
        code: WEBHOOK_ERROR.TOKEN_INVALID,
      });
    }

    if (!trigger.enabled) {
      throw new AppError('Trigger is disabled', {
        status: 409,
        code: WEBHOOK_ERROR.TRIGGER_DISABLED,
      });
    }

    const parsed = parseWebhookPayload(input.type, input.payload);
    const project = new ProjectRepository(this.db, trigger.tenantId).findById(trigger.projectId);

    if (project === undefined) {
      throw new AppError('Webhook token is invalid', {
        status: 401,
        code: WEBHOOK_ERROR.TOKEN_INVALID,
      });
    }

    if (input.type === 'deployment') {
      const environment = this.engine.resolveEnvironment(trigger, project.id);

      if (environment !== undefined) {
        new EnvironmentRepository(this.db, trigger.tenantId).update(
          environment.id,
          { deployedSha: parsed.headSha },
          this.now(),
        );
      }
    }

    const result = this.engine.fire({
      trigger,
      project,
      headSha: parsed.headSha,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
    });

    this.auditWriter.append({
      tenantId: trigger.tenantId,
      action: AUDIT_ACTION.TRIGGER_FIRE,
      resourceType: AUDIT_RESOURCE_TYPE.TRIGGER,
      resourceId: trigger.id,
      detail: {
        projectId: project.id,
        type: input.type,
        kind: result.kind,
        resultId: result.id,
        created: result.created,
        reason: result.reason,
      },
      now: this.now(),
    });

    return result;
  }

  private audit(
    context: AuthContext,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    triggerId: string,
    detail: Record<string, unknown>,
  ): void {
    this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action,
      resourceType: AUDIT_RESOURCE_TYPE.TRIGGER,
      resourceId: triggerId,
      detail,
      now: this.now(),
    });
  }
}
