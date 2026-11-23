// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { nowMs, uuidv7, ValidationError } from '@gait/config';
import type { AuditAction } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { BaseRepository, requireRow, TenantScopedRepository } from '../repository.js';
import { auditLogs, users } from '../schema.js';
import type { AuditLog } from '../schema.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_DETAIL_LENGTH = 2_000;

export interface AppendAuditLogInput {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
  now?: number;
}

export interface AuditLogView {
  id: string;
  tenantId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  ip: string | null;
  userAgent: string | null;
  detailJson: string;
  createdAt: number;
}

export interface AuditLogQuery {
  cursor?: string;
  limit?: number;
  action?: AuditAction;
  resourceType?: string;
}

export interface AuditLogPage {
  items: AuditLogView[];
  nextCursor: string | null;
}

function serializeDetail(detail: unknown): string {
  if (detail === undefined) {
    return '{}';
  }

  const json = JSON.stringify(detail) ?? '{}';

  return json.length > MAX_DETAIL_LENGTH ? json.slice(0, MAX_DETAIL_LENGTH) : json;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

export function encodeAuditCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}:${id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(cursor: string): { createdAt: number; id: string } {
  let decoded: string;

  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('Invalid audit cursor');
  }

  const match = /^(\d{1,16}):([A-Za-z0-9-]{1,64})$/.exec(decoded);

  if (match === null) {
    throw new ValidationError('Invalid audit cursor');
  }

  const createdAt = Number(match[1]);

  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new ValidationError('Invalid audit cursor');
  }

  return { createdAt, id: match[2] as string };
}

/**
 * 审计写入器不强制租户：失败登录等事件可能还没有可归属的租户。
 * 所有业务写入必须显式传入已校验的 tenantId。
 */
export class AuditLogWriter extends BaseRepository {
  constructor(db: AppDatabase) {
    super(db);
  }

  async append(input: AppendAuditLogInput): Promise<AuditLog> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(auditLogs)
      .values({
        id: uuidv7(now),
        tenantId: input.tenantId ?? null,
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        detailJson: serializeDetail(input.detail),
        createdAt: now,
      })
      .returning();

    return requireRow(row);
  }
}

/** 租户审计查询强制 tenant_id 过滤，跨租户日志不可见。 */
export class TenantAuditLogRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async list(query: AuditLogQuery = {}): Promise<AuditLogPage> {
    const limit = clampLimit(query.limit);
    const conditions: SQL[] = [eq(auditLogs.tenantId, this.tenantId)];

    if (query.action !== undefined) {
      conditions.push(eq(auditLogs.action, query.action));
    }

    if (query.resourceType !== undefined) {
      conditions.push(eq(auditLogs.resourceType, query.resourceType));
    }

    if (query.cursor !== undefined) {
      const cursor = decodeAuditCursor(query.cursor);
      const cursorCondition = or(
        lt(auditLogs.createdAt, cursor.createdAt),
        and(eq(auditLogs.createdAt, cursor.createdAt), lt(auditLogs.id, cursor.id)),
      );

      if (cursorCondition !== undefined) {
        conditions.push(cursorCondition);
      }
    }

    const rows = await this.db
      .select({
        id: auditLogs.id,
        tenantId: auditLogs.tenantId,
        actorUserId: auditLogs.actorUserId,
        actorUsername: users.username,
        actorDisplayName: users.displayName,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        ip: auditLogs.ip,
        userAgent: auditLogs.userAgent,
        detailJson: auditLogs.detailJson,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorUserId, users.id))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => ({
      ...row,
      actorUsername: row.actorUsername ?? null,
      actorDisplayName: row.actorDisplayName ?? null,
    }));
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last !== undefined ? encodeAuditCursor(last.createdAt, last.id) : null,
    };
  }
}
