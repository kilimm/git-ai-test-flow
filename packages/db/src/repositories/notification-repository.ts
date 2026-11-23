// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { NotificationStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { requireRow, TenantScopedRepository } from '../repository.js';
import { notifications } from '../schema.js';
import type { Notification } from '../schema.js';

export interface CreateNotificationInput {
  id?: string;
  projectId: string;
  runId: string;
  channelId?: string | null;
  eventType: string;
  status?: NotificationStatus;
  payload?: unknown;
  dedupeKey: string;
  now?: number;
}

export interface UpdateNotificationInput {
  status?: NotificationStatus;
  attempts?: number;
  responseStatus?: number | null;
  responseBody?: string | null;
  sentAt?: number | null;
}

export class NotificationRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  async create(input: CreateNotificationInput): Promise<Notification> {
    const now = input.now ?? nowMs();
    const [row] = await this.db
      .insert(notifications)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        runId: input.runId,
        channelId: input.channelId ?? null,
        eventType: input.eventType,
        status: input.status ?? 'pending',
        payloadJson: JSON.stringify(input.payload ?? {}),
        dedupeKey: input.dedupeKey,
        createdAt: now,
      })
      .returning();

    return requireRow(row);
  }

  async findByDedupe(dedupeKey: string): Promise<Notification | undefined> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, this.tenantId), eq(notifications.dedupeKey, dedupeKey)))
      .limit(1);

    return row;
  }

  async findById(id: string): Promise<Notification | undefined> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.tenantId, this.tenantId)))
      .limit(1);

    return row;
  }

  async listByRun(runId: string): Promise<Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, this.tenantId), eq(notifications.runId, runId)))
      .orderBy(notifications.createdAt);
  }

  async listByProject(projectId: string, limit = 100): Promise<Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, this.tenantId), eq(notifications.projectId, projectId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async update(id: string, input: UpdateNotificationInput): Promise<Notification | undefined> {
    const values: Partial<Notification> = {};

    if (input.status !== undefined) {
      values.status = input.status;
    }

    if (input.attempts !== undefined) {
      values.attempts = input.attempts;
    }

    if (input.responseStatus !== undefined) {
      values.responseStatus = input.responseStatus;
    }

    if (input.responseBody !== undefined) {
      values.responseBody = input.responseBody;
    }

    if (input.sentAt !== undefined) {
      values.sentAt = input.sentAt;
    }

    const [row] = await this.db
      .update(notifications)
      .set(values)
      .where(and(eq(notifications.id, id), eq(notifications.tenantId, this.tenantId)))
      .returning();

    return row;
  }
}
