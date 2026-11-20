// 本文件所有改动要求遵循 agent-rules 规范
import { NotFoundError, ValidationError, uuidv7 } from '@gait/config';
import { NotificationChannelRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, NotificationChannel } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  NOTIFICATION_TEST_STATUS,
  isFeishuWebhookUrl,
} from '@gait/shared';
import type { NotificationEvent, NotificationTestStatus } from '@gait/shared';
import type {
  CreateNotificationChannelBody,
  UpdateNotificationChannelBody,
} from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
import {
  buildFeishuTestCard,
  createFeishuSignature,
  parseFeishuResponse,
} from '../config/feishu.js';
import { HttpTimeoutError } from '../config/http-client.js';
import { SECRET_AAD_TYPE, maskWebhookUrl } from '../config/secrets.js';
import { BlockedTargetError, DnsResolutionError } from '../config/ssrf.js';
import type { ConfigServiceDeps } from './support.js';
import { parseJsonArray, requireProject, toIsoOrNull, writeConfigAudit } from './support.js';

export interface NotificationChannelView {
  id: string;
  projectId: string;
  name: string;
  maskedWebhook: string;
  events: NotificationEvent[];
  enabled: boolean;
  lastTestedAt: string | null;
  lastTestStatus: NotificationTestStatus;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationTestResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  testedAt: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class NotificationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly deps: ConfigServiceDeps,
  ) {}

  private decrypt(
    context: AuthContext,
    channel: NotificationChannel,
    which: 'webhook' | 'secret',
  ): string {
    const payload =
      which === 'webhook'
        ? {
            ciphertext: channel.webhookCiphertext,
            iv: channel.webhookIv,
            authTag: channel.webhookAuthTag,
            keyVersion: channel.webhookKeyVersion,
          }
        : {
            ciphertext: channel.secretCiphertext,
            iv: channel.secretIv,
            authTag: channel.secretAuthTag,
            keyVersion: channel.secretKeyVersion,
          };
    const type =
      which === 'webhook' ? SECRET_AAD_TYPE.FEISHU_WEBHOOK : SECRET_AAD_TYPE.FEISHU_SIGNING_SECRET;

    return this.deps.cipher.decrypt(context.tenant.id, channel.id, type, payload);
  }

  private view(context: AuthContext, channel: NotificationChannel): NotificationChannelView {
    return {
      id: channel.id,
      projectId: channel.projectId,
      name: channel.name,
      maskedWebhook: maskWebhookUrl(this.decrypt(context, channel, 'webhook')),
      events: parseJsonArray<NotificationEvent>(channel.eventsJson),
      enabled: channel.enabled,
      lastTestedAt: toIsoOrNull(channel.lastTestedAt),
      lastTestStatus: channel.lastTestStatus,
      lastTestMessage: channel.lastTestMessage,
      createdAt: new Date(channel.createdAt).toISOString(),
      updatedAt: new Date(channel.updatedAt).toISOString(),
    };
  }

  private requireChannel(context: AuthContext, channelId: string): NotificationChannel {
    const channel = new NotificationChannelRepository(this.db, context.tenant.id).findById(
      channelId,
    );

    if (channel === undefined) {
      throw new NotFoundError('Notification channel not found');
    }

    return channel;
  }

  private assertWebhook(webhookUrl: string): void {
    if (!isFeishuWebhookUrl(webhookUrl)) {
      throw new ValidationError('Webhook must be an HTTPS Feishu/Lark URL');
    }
  }

  create(
    context: AuthContext,
    projectId: string,
    input: CreateNotificationChannelBody,
  ): NotificationChannelView {
    requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    this.assertWebhook(input.webhookUrl);
    const repository = new NotificationChannelRepository(this.db, context.tenant.id);

    if (repository.findByName(projectId, input.name) !== undefined) {
      throw new ValidationError('Notification channel name already exists');
    }

    const now = this.deps.now();
    const id = uuidv7(now);
    const channel = repository.create({
      id,
      projectId,
      name: input.name,
      webhook: this.deps.cipher.encrypt(
        context.tenant.id,
        id,
        SECRET_AAD_TYPE.FEISHU_WEBHOOK,
        input.webhookUrl,
      ),
      secret: this.deps.cipher.encrypt(
        context.tenant.id,
        id,
        SECRET_AAD_TYPE.FEISHU_SIGNING_SECRET,
        input.secret,
      ),
      eventsJson: JSON.stringify(input.events),
      enabled: input.enabled,
      now,
    });

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.NOTIFICATION_CHANNEL_CREATE,
      AUDIT_RESOURCE_TYPE.NOTIFICATION_CHANNEL,
      channel.id,
      { name: channel.name, events: input.events },
    );

    return this.view(context, channel);
  }

  list(context: AuthContext, projectId: string): NotificationChannelView[] {
    requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);

    return new NotificationChannelRepository(this.db, context.tenant.id)
      .listByProject(projectId)
      .map((channel) => this.view(context, channel));
  }

  update(
    context: AuthContext,
    channelId: string,
    input: UpdateNotificationChannelBody,
  ): NotificationChannelView {
    const repository = new NotificationChannelRepository(this.db, context.tenant.id);
    const existing = this.requireChannel(context, channelId);

    if (input.name !== undefined && input.name !== existing.name) {
      if (repository.findByName(existing.projectId, input.name) !== undefined) {
        throw new ValidationError('Notification channel name already exists');
      }
    }

    if (input.webhookUrl !== undefined) {
      this.assertWebhook(input.webhookUrl);
    }

    const now = this.deps.now();
    const updated = repository.update(
      channelId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.webhookUrl === undefined
          ? {}
          : {
              webhook: this.deps.cipher.encrypt(
                context.tenant.id,
                channelId,
                SECRET_AAD_TYPE.FEISHU_WEBHOOK,
                input.webhookUrl,
              ),
            }),
        ...(input.secret === undefined
          ? {}
          : {
              secret: this.deps.cipher.encrypt(
                context.tenant.id,
                channelId,
                SECRET_AAD_TYPE.FEISHU_SIGNING_SECRET,
                input.secret,
              ),
            }),
        ...(input.events === undefined ? {} : { eventsJson: JSON.stringify(input.events) }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
      now,
    );

    if (updated === undefined) {
      throw new ValidationError('Notification channel was not updated');
    }

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.NOTIFICATION_CHANNEL_UPDATE,
      AUDIT_RESOURCE_TYPE.NOTIFICATION_CHANNEL,
      updated.id,
      {
        name: updated.name,
        fields: Object.keys(input),
        webhookRotated: input.webhookUrl !== undefined,
        secretRotated: input.secret !== undefined,
      },
    );

    return this.view(context, updated);
  }

  remove(context: AuthContext, channelId: string): void {
    const repository = new NotificationChannelRepository(this.db, context.tenant.id);
    const channel = this.requireChannel(context, channelId);

    repository.remove(channelId);
    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.NOTIFICATION_CHANNEL_DELETE,
      AUDIT_RESOURCE_TYPE.NOTIFICATION_CHANNEL,
      channel.id,
      { name: channel.name },
    );
  }

  async test(context: AuthContext, channelId: string): Promise<NotificationTestResult> {
    const channel = this.requireChannel(context, channelId);
    const webhookUrl = this.decrypt(context, channel, 'webhook');
    const secret = this.decrypt(context, channel, 'secret');
    const project = new ProjectRepository(this.db, context.tenant.id).findById(channel.projectId);
    const testedAt = this.deps.now();
    const startedAt = Date.now();
    const finish = (
      status: 'ok' | 'failed',
      code: string,
      message: string,
    ): NotificationTestResult => {
      const testStatus =
        status === 'ok' ? NOTIFICATION_TEST_STATUS.SUCCESS : NOTIFICATION_TEST_STATUS.FAILED;
      const sanitized = message.split(secret).join('****').slice(0, 300);

      new NotificationChannelRepository(this.db, context.tenant.id).update(
        channelId,
        {
          lastTestedAt: testedAt,
          lastTestStatus: testStatus,
          lastTestMessage: sanitized,
        },
        testedAt,
      );
      writeConfigAudit(
        this.deps,
        context,
        AUDIT_ACTION.NOTIFICATION_CHANNEL_TEST,
        AUDIT_RESOURCE_TYPE.NOTIFICATION_CHANNEL,
        channelId,
        { result: status, code },
      );

      return {
        status,
        code,
        message: sanitized,
        testedAt: new Date(testedAt).toISOString(),
        durationMs: Date.now() - startedAt,
      };
    };

    try {
      await this.deps.urlSafety.assertRequestTarget(webhookUrl, { httpsOnly: true });
    } catch (error) {
      if (error instanceof DnsResolutionError) {
        return finish('failed', 'DNS_FAILURE', error.message);
      }

      if (error instanceof BlockedTargetError) {
        throw error;
      }

      return finish(
        'failed',
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Unable to resolve webhook host',
      );
    }

    const timestampSeconds = Math.floor(testedAt / 1000);
    const body = JSON.stringify({
      timestamp: String(timestampSeconds),
      sign: createFeishuSignature(timestampSeconds, secret),
      msg_type: 'interactive',
      card: buildFeishuTestCard({
        projectName: project?.name ?? '未知项目',
        channelName: channel.name,
        triggeredAt: testedAt,
      }),
    });

    let response;

    try {
      response = await this.deps.httpClient({
        method: 'POST',
        url: webhookUrl,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof HttpTimeoutError) {
        return finish('failed', 'TIMEOUT', 'Feishu webhook request timed out');
      }

      return finish(
        'failed',
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'Feishu webhook request failed',
      );
    }

    const parsed = parseFeishuResponse(response.status, response.bodyText);

    return finish(parsed.ok ? 'ok' : 'failed', parsed.code, parsed.message);
  }
}
