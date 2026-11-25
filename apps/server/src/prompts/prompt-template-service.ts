// 本文件所有改动要求遵循 agent-rules 规范
import {
  DEFAULT_STAGE_PROMPTS,
  PROMPT_STAGE_META,
  PROMPT_STAGE_NAMES,
  isPromptStageName,
} from '@gait/agent';
import type { PromptOverrides, PromptStageName } from '@gait/agent';
import { AuditLogWriter, PromptTemplateRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';

export interface PromptStageView {
  stage: PromptStageName;
  label: string;
  description: string;
  /** 当前生效的系统提示词（自定义或默认）。 */
  content: string;
  /** 是否使用自定义内容。 */
  customized: boolean;
  version: number;
  updatedAt: string | null;
  defaultContent: string;
}

export interface PromptTemplateServiceOptions {
  db: AppDatabase;
  auditWriter: AuditLogWriter;
}

/**
 * 生成阶段提示词管理（tenant 级）。
 *
 * - 读写按租户隔离；不存在即视为使用内置默认；
 * - 保存时 version+1，写审计，便于追溯是谁改的；
 * - 生成任务启动时据此构造 PromptOverrides（含额外需求说明）。
 */
export class PromptTemplateService {
  private readonly db: AppDatabase;
  private readonly auditWriter: AuditLogWriter;

  constructor(options: PromptTemplateServiceOptions) {
    this.db = options.db;
    this.auditWriter = options.auditWriter;
  }

  private repository(context: AuthContext): PromptTemplateRepository {
    return new PromptTemplateRepository(this.db, context.tenant.id);
  }

  async list(context: AuthContext): Promise<PromptStageView[]> {
    const saved = await this.repository(context).list();
    const byStage = new Map(saved.map((entry) => [entry.stage, entry]));

    return PROMPT_STAGE_NAMES.map((stage) => {
      const entry = byStage.get(stage);
      const defaultContent = DEFAULT_STAGE_PROMPTS[stage];
      const customized = entry !== undefined && entry.content.trim().length > 0;

      return {
        stage,
        label: PROMPT_STAGE_META[stage].label,
        description: PROMPT_STAGE_META[stage].description,
        content: customized ? (entry?.content ?? defaultContent) : defaultContent,
        customized,
        version: entry?.version ?? 0,
        updatedAt: entry === undefined ? null : new Date(entry.updatedAt).toISOString(),
        defaultContent,
      };
    });
  }

  /** 用空串表示恢复默认值。 */
  async save(
    context: AuthContext,
    stage: string,
    content: string,
  ): Promise<PromptStageView> {
    if (!isPromptStageName(stage)) {
      throw new Error(`Unknown prompt stage: ${stage}`);
    }

    const entry = await this.repository(context).upsert(stage, content, context.user.id);

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.PROMPT_TEMPLATE_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROMPT_TEMPLATE,
      resourceId: context.tenant.id,
      detail: { promptStage: stage, version: entry.version, customized: content.trim().length > 0 },
    });

    const views = await this.list(context);

    return views.find((view) => view.stage === stage) as PromptStageView;
  }

  /**
   * 生成任务用：只用自定义内容非空的阶段，没有自定义的阶段交由代码内置默认。
   * 这样 DB 中留存的空串行不会覆盖默认行为。
   */
  async resolveOverrides(context: AuthContext): Promise<PromptOverrides> {
    const saved = await this.repository(context).list();
    const overrides: PromptOverrides = {};

    for (const entry of saved) {
      const content = entry.content.trim();

      if (content.length === 0) {
        continue;
      }

      overrides[entry.stage] = { system: content };
    }

    return overrides;
  }
}
