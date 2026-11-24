// 本文件所有改动要求遵循 agent-rules 规范
import { ConflictError, NotFoundError, ValidationError } from '@gait/config';
import { AuditLogWriter } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { ScriptLibraryRepository } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from '@gait/shared';
import type { ScriptKind, ScriptParamSpec, ScriptStatus } from '@gait/shared';
import { activateScript, compileStepPattern, createScriptDraft } from '@gait/runner';
import type { AuthContext } from '../auth/auth-service.js';

export interface ScriptView {
  id: string;
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params: ScriptParamSpec[];
  examples: string[];
  source: string | null;
  status: ScriptStatus;
  version: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptListInput {
  query?: string;
  modules?: string[];
  kinds?: ScriptKind[];
  statuses?: ScriptStatus[];
  limit?: number;
}

export interface CreateScriptBody {
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params?: ScriptParamSpec[];
  examples?: string[];
  source?: string;
}

export interface UpdateScriptBody {
  description?: string;
  params?: ScriptParamSpec[];
  examples?: string[];
  source?: string;
  status?: ScriptStatus;
}

export interface CreateScriptResult {
  ok: boolean;
  script: ScriptView | null;
  reason: string | null;
  conflictWith: string | null;
}

export interface ScriptLibraryServiceOptions {
  db: AppDatabase;
  auditWriter: AuditLogWriter;
}

const SOURCE_KINDS = new Set<ScriptKind>(['script', 'template']);

/**
 * 脚本库服务（tenant 级）：所有读写都必须带 tenantId，禁止跨租户访问。
 * 写入走 guard：pattern 可编译、不与 active 条目冲突、source 与 kind 匹配。
 */
export class ScriptLibraryService {
  private readonly db: AppDatabase;
  private readonly auditWriter: AuditLogWriter;

  constructor(options: ScriptLibraryServiceOptions) {
    this.db = options.db;
    this.auditWriter = options.auditWriter;
  }

  private repository(context: AuthContext): ScriptLibraryRepository {
    return new ScriptLibraryRepository(this.db, context.tenant.id);
  }

  private toView(entry: {
    id: string;
    moduleKey: string;
    name: string;
    kind: ScriptKind;
    pattern: string;
    description: string;
    params: ScriptParamSpec[];
    examples: string[];
    source: string | null;
    status: ScriptStatus;
    version: number;
    createdBy: string | null;
    createdAt: number;
    updatedAt: number;
  }): ScriptView {
    return {
      id: entry.id,
      moduleKey: entry.moduleKey,
      name: entry.name,
      kind: entry.kind,
      pattern: entry.pattern,
      description: entry.description,
      params: entry.params,
      examples: entry.examples,
      source: entry.source,
      status: entry.status,
      version: entry.version,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /** 列表：默认只返回 active，可显式查 draft（待审脚本）。 */
  async list(context: AuthContext, input: ScriptListInput): Promise<ScriptView[]> {
    const statuses = input.statuses ?? ['active'];
    const rows = await this.repository(context).listAll();
    const needle = input.query?.trim().toLowerCase();

    return rows
      .filter((row) => statuses.includes(row.status))
      .filter((row) => input.modules === undefined || input.modules.includes(row.moduleKey))
      .filter((row) => input.kinds === undefined || input.kinds.includes(row.kind))
      .filter((row) => {
        if (needle === undefined || needle.length === 0) {
          return true;
        }

        return [row.name, row.pattern, row.description, row.moduleKey].some((field) =>
          field.toLowerCase().includes(needle),
        );
      })
      .slice(0, input.limit ?? 200)
      .map((row) => this.toView(row));
  }

  async get(context: AuthContext, id: string): Promise<ScriptView> {
    const entry = await this.repository(context).findById(id);

    if (entry === null) {
      throw new NotFoundError('Script not found');
    }

    return this.toView(entry);
  }

  async create(context: AuthContext, body: CreateScriptBody): Promise<CreateScriptResult> {
    if (SOURCE_KINDS.has(body.kind) && (body.source === undefined || body.source.trim() === '')) {
      throw new ValidationError(`${body.kind} 类型的脚本必须提供 source`);
    }

    if (!SOURCE_KINDS.has(body.kind) && body.source !== undefined && body.source.trim() !== '') {
      throw new ValidationError(`${body.kind} 类型的脚本由 runner 内置执行器处理，不接受 source`);
    }

    const result = await createScriptDraft(
      this.repository(context),
      {
        moduleKey: body.moduleKey,
        name: body.name,
        kind: body.kind,
        pattern: body.pattern,
        description: body.description,
        params: body.params ?? [],
        examples: body.examples ?? [],
        source: body.source ?? null,
        createdBy: context.user.id,
      },
      compileStepPattern,
    );

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PROJECT_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
      resourceId: body.moduleKey,
      detail: {
        scope: 'script_library',
        action: 'create',
        name: body.name,
        ok: result.ok,
        reason: result.reason,
      },
    });

    if (!result.ok || result.entryId === null) {
      return {
        ok: false,
        script: null,
        reason: result.reason,
        conflictWith: result.conflictWith,
      };
    }

    return {
      ok: true,
      script: await this.get(context, result.entryId),
      reason: null,
      conflictWith: null,
    };
  }

  async update(
    context: AuthContext,
    id: string,
    body: UpdateScriptBody,
  ): Promise<ScriptView> {
    const repository = this.repository(context);
    const existing = await repository.findById(id);

    if (existing === null) {
      throw new NotFoundError('Script not found');
    }

    if (body.source !== undefined && !SOURCE_KINDS.has(existing.kind)) {
      throw new ValidationError(`${existing.kind} 类型的脚本不接受 source`);
    }

    // 已激活的脚本改内容必须走 bumpVersion，便于追溯是哪版脚本产生的失败。
    const entry = await repository.update(id, {
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.params === undefined ? {} : { params: body.params }),
      ...(body.examples === undefined ? {} : { examples: body.examples }),
      ...(body.source === undefined ? {} : { source: body.source }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.source === undefined ? {} : { bumpVersion: true }),
    });

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PROJECT_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
      resourceId: existing.moduleKey,
      detail: { scope: 'script_library', action: 'update', name: existing.name, id },
    });

    return this.toView(entry);
  }

  /** draft → active：语义是「已用真实用例验证通过」。 */
  async activate(context: AuthContext, id: string): Promise<ScriptView> {
    const repository = this.repository(context);
    const existing = await repository.findById(id);

    if (existing === null) {
      throw new NotFoundError('Script not found');
    }

    if (existing.status === 'active') {
      return this.toView(existing);
    }

    if (existing.status !== 'draft') {
      throw new ConflictError(`只有 draft 脚本可以激活，当前状态：${existing.status}`);
    }

    const activated = await activateScript(repository, id);

    if (!activated) {
      throw new ConflictError('脚本激活失败');
    }

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PROJECT_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROJECT,
      resourceId: existing.moduleKey,
      detail: { scope: 'script_library', action: 'activate', name: existing.name, id },
    });

    return await this.get(context, id);
  }
}
