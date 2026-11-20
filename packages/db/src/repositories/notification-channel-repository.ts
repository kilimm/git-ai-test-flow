// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { NotificationTestStatus } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { notificationChannels } from '../schema.js';
import type { NewNotificationChannel, NotificationChannel } from '../schema.js';
import type { EncryptedSecret } from './credential-repository.js';

export interface CreateNotificationChannelInput {
  id?: string;
  projectId: string;
  name: string;
  webhook: EncryptedSecret;
  secret: EncryptedSecret;
  eventsJson: string;
  enabled: boolean;
  now?: number;
}

export interface UpdateNotificationChannelInput {
  name?: string;
  webhook?: EncryptedSecret;
  secret?: EncryptedSecret;
  eventsJson?: string;
  enabled?: boolean;
  lastTestedAt?: number | null;
  lastTestStatus?: NotificationTestStatus;
  lastTestMessage?: string | null;
}

export class NotificationChannelRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateNotificationChannelInput): NotificationChannel {
    const now = input.now ?? nowMs();

    return this.db
      .insert(notificationChannels)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        name: input.name,
        webhookCiphertext: input.webhook.ciphertext,
        webhookIv: input.webhook.iv,
        webhookAuthTag: input.webhook.authTag,
        webhookKeyVersion: input.webhook.keyVersion,
        secretCiphertext: input.secret.ciphertext,
        secretIv: input.secret.iv,
        secretAuthTag: input.secret.authTag,
        secretKeyVersion: input.secret.keyVersion,
        eventsJson: input.eventsJson,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  listByProject(projectId: string): NotificationChannel[] {
    return this.db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.tenantId, this.tenantId),
          eq(notificationChannels.projectId, projectId),
        ),
      )
      .orderBy(desc(notificationChannels.createdAt), desc(notificationChannels.id))
      .all();
  }

  findById(id: string): NotificationChannel | undefined {
    return this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.tenantId, this.tenantId)))
      .get();
  }

  findByName(projectId: string, name: string): NotificationChannel | undefined {
    return this.db
      .select()
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.tenantId, this.tenantId),
          eq(notificationChannels.projectId, projectId),
          eq(notificationChannels.name, name),
        ),
      )
      .get();
  }

  update(
    id: string,
    input: UpdateNotificationChannelInput,
    now: number = nowMs(),
  ): NotificationChannel | undefined {
    const values: Partial<NewNotificationChannel> = { updatedAt: now };

    if (input.name !== undefined) {
      values.name = input.name;
    }

    if (input.webhook !== undefined) {
      values.webhookCiphertext = input.webhook.ciphertext;
      values.webhookIv = input.webhook.iv;
      values.webhookAuthTag = input.webhook.authTag;
      values.webhookKeyVersion = input.webhook.keyVersion;
    }

    if (input.secret !== undefined) {
      values.secretCiphertext = input.secret.ciphertext;
      values.secretIv = input.secret.iv;
      values.secretAuthTag = input.secret.authTag;
      values.secretKeyVersion = input.secret.keyVersion;
    }

    if (input.eventsJson !== undefined) {
      values.eventsJson = input.eventsJson;
    }

    if (input.enabled !== undefined) {
      values.enabled = input.enabled;
    }

    if (input.lastTestedAt !== undefined) {
      values.lastTestedAt = input.lastTestedAt;
    }

    if (input.lastTestStatus !== undefined) {
      values.lastTestStatus = input.lastTestStatus;
    }

    if (input.lastTestMessage !== undefined) {
      values.lastTestMessage = input.lastTestMessage;
    }

    return this.db
      .update(notificationChannels)
      .set(values)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.tenantId, this.tenantId)))
      .returning()
      .get();
  }

  remove(id: string): boolean {
    const result = this.db
      .delete(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.tenantId, this.tenantId)))
      .run();

    return result.changes > 0;
  }
}
