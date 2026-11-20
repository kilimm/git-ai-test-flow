// 本文件所有改动要求遵循 agent-rules 规范
import { UrlSafetyChecker } from '@gait/config';
import { BlockedTargetError, DnsResolutionError } from '@gait/config';
import type { AppEnv, SecretCipher } from '@gait/config';
import {
  NotificationChannelRepository,
  NotificationRepository,
  ProjectRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, Notification, NotificationChannel } from '@gait/db';
import { ANALYSIS_LIMITS, NOTIFICATION_EVENT, NOTIFICATION_STATUS } from '@gait/shared';
import type { RunReport } from '@gait/shared';
import { redactText } from '@gait/runner';
import { buildRunReport } from '../report/report-builder.js';
import { buildRunFeishuCard, createFeishuSignature, parseFeishuResponse } from './feishu.js';

const WEBHOOK_AAD = 'feishu_webhook_url';
const SECRET_AAD = 'feishu_sign_secret';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CARD_BYTES = 20 * 1024;

export interface NotifyRunOptions {
  db: AppDatabase;
  tenantId: string;
  runId: string;
  env: AppEnv;
  cipher: SecretCipher;
  baseUrl?: string;
  report?: RunReport;
  fetchImpl?: typeof fetch;
  urlSafety?: UrlSafetyChecker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    info?(details: Record<string, unknown>, message?: string): void;
    warn?(details: Record<string, unknown>, message?: string): void;
  };
}

export interface NotificationAttemptResult {
  notificationId: string;
  channelId: string;
  eventType: string;
  status: string;
  attempts: number;
  error: { code: string; message: string } | null;
}

export interface NotifyRunResult {
  sent: number;
  failed: number;
  skipped: number;
  results: NotificationAttemptResult[];
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chooseEvent(events: readonly string[], failed: boolean): string | null {
  if (failed && events.includes(NOTIFICATION_EVENT.RUN_FAILED)) {
    return NOTIFICATION_EVENT.RUN_FAILED;
  }

  if (events.includes(NOTIFICATION_EVENT.RUN_FINISHED)) {
    return NOTIFICATION_EVENT.RUN_FINISHED;
  }

  return null;
}

function decryptChannel(
  cipher: SecretCipher,
  tenantId: string,
  channel: NotificationChannel,
  which: 'webhook' | 'secret',
): string {
  return which === 'webhook'
    ? cipher.decrypt(tenantId, channel.id, WEBHOOK_AAD, {
        ciphertext: channel.webhookCiphertext,
        iv: channel.webhookIv,
        authTag: channel.webhookAuthTag,
        keyVersion: channel.webhookKeyVersion,
      })
    : cipher.decrypt(tenantId, channel.id, SECRET_AAD, {
        ciphertext: channel.secretCiphertext,
        iv: channel.secretIv,
        authTag: channel.secretAuthTag,
        keyVersion: channel.secretKeyVersion,
      });
}

interface DeliverContext {
  notification: Notification;
  channel: NotificationChannel;
  webhookUrl: string;
  secret: string;
  card: Record<string, unknown>;
  remainingAttempts: number;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  repository: NotificationRepository;
  log: (details: Record<string, unknown>, message: string) => void;
}

async function deliver(context: DeliverContext): Promise<NotificationAttemptResult> {
  let attempts = context.notification.attempts;
  let lastError: { code: string; message: string } | null = null;
  let responseStatus: number | null = null;
  let responseBody: string | null = null;

  for (let index = 0; index < context.remainingAttempts; index += 1) {
    attempts += 1;
    const timestampSeconds = Math.floor(context.now() / 1000);
    const body = JSON.stringify({
      timestamp: String(timestampSeconds),
      sign: createFeishuSignature(timestampSeconds, context.secret),
      msg_type: 'interactive',
      card: context.card,
    });

    if (Buffer.byteLength(body, 'utf8') > MAX_CARD_BYTES) {
      lastError = { code: 'CARD_TOO_LARGE', message: 'Feishu card exceeds 20 KB' };
      break;
    }

    try {
      const response = await context.fetchImpl(context.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      responseStatus = response.status;
      const text = (await response.text()).slice(
        0,
        ANALYSIS_LIMITS.MAX_NOTIFICATION_RESPONSE_CHARS,
      );
      responseBody = redactText(text);
      const parsed = parseFeishuResponse(response.status, text);

      if (parsed.ok) {
        const sent = context.repository.update(context.notification.id, {
          status: NOTIFICATION_STATUS.SENT,
          attempts,
          responseStatus,
          responseBody,
          sentAt: context.now(),
        });

        context.log(
          { notificationId: context.notification.id, attempts, status: response.status },
          'feishu notification sent',
        );

        return {
          notificationId: context.notification.id,
          channelId: context.channel.id,
          eventType: context.notification.eventType,
          status: sent?.status ?? NOTIFICATION_STATUS.SENT,
          attempts,
          error: null,
        };
      }

      lastError = { code: parsed.code, message: parsed.message };
    } catch (error) {
      lastError = {
        code: 'NETWORK_ERROR',
        message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }

    context.repository.update(context.notification.id, {
      status: NOTIFICATION_STATUS.PENDING,
      attempts,
      responseStatus,
      responseBody,
    });

    if (index < context.remainingAttempts - 1) {
      await context.sleep(500 * 2 ** index);
    }
  }

  const failed = context.repository.update(context.notification.id, {
    status: NOTIFICATION_STATUS.FAILED,
    attempts,
    responseStatus,
    responseBody:
      responseBody ??
      (lastError === null ? null : redactText(`${lastError.code}: ${lastError.message}`)),
  });

  context.log(
    { notificationId: context.notification.id, attempts, error: lastError },
    'feishu notification failed',
  );

  return {
    notificationId: context.notification.id,
    channelId: context.channel.id,
    eventType: context.notification.eventType,
    status: failed?.status ?? NOTIFICATION_STATUS.FAILED,
    attempts,
    error: lastError,
  };
}

/**
 * Graph B 通知阶段：
 * - 按 Run 汇总发送，不按用例逐条发送；
 * - dedupe_key = runId:channelId:eventType，重复调用幂等；
 * - 每个通知最多 3 次尝试，失败记录状态与响应；
 * - Webhook/Secret 只存在于内存，日志与数据库不保存明文。
 */
export async function notifyRun(options: NotifyRunOptions): Promise<NotifyRunResult> {
  const clock = options.now ?? (() => Date.now());
  const run = new RunRepository(options.db, options.tenantId).findById(options.runId);

  if (run === undefined) {
    throw new Error(`Run not found: ${options.runId}`);
  }

  const project = new ProjectRepository(options.db, options.tenantId).findById(run.projectId);

  if (project === undefined) {
    throw new Error('Run project not found');
  }

  const channels = new NotificationChannelRepository(options.db, options.tenantId)
    .listByProject(project.id)
    .filter((channel) => channel.enabled);
  const notificationRepository = new NotificationRepository(options.db, options.tenantId);
  const failedRun = run.status === 'failed';
  const report =
    options.report ??
    buildRunReport({
      db: options.db,
      tenantId: options.tenantId,
      runId: run.id,
      baseUrl: options.baseUrl ?? options.env.PUBLIC_BASE_URL,
      now: clock,
    });
  const card = buildRunFeishuCard(report);
  const urlSafety =
    options.urlSafety ?? new UrlSafetyChecker({ allowlist: options.env.SSRF_ALLOWLIST });
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const result: NotifyRunResult = { sent: 0, failed: 0, skipped: 0, results: [] };
  const log = (details: Record<string, unknown>, message: string): void => {
    options.logger?.info?.({ runId: run.id, ...details }, message);
  };

  for (const channel of channels) {
    const events = parseArray<string>(channel.eventsJson);
    const eventType = chooseEvent(events, failedRun);

    if (eventType === null) {
      result.skipped += 1;
      continue;
    }

    const dedupeKey = `${run.id}:${channel.id}:${eventType}`;
    let notification = notificationRepository.findByDedupe(dedupeKey);

    if (notification?.status === NOTIFICATION_STATUS.SENT) {
      result.skipped += 1;
      result.results.push({
        notificationId: notification.id,
        channelId: channel.id,
        eventType,
        status: notification.status,
        attempts: notification.attempts,
        error: null,
      });
      continue;
    }

    if (
      notification !== undefined &&
      notification.attempts >= ANALYSIS_LIMITS.MAX_NOTIFICATION_ATTEMPTS
    ) {
      result.skipped += 1;
      result.results.push({
        notificationId: notification.id,
        channelId: channel.id,
        eventType,
        status: notification.status,
        attempts: notification.attempts,
        error: { code: 'RETRY_EXHAUSTED', message: 'Notification retry limit reached' },
      });
      continue;
    }

    if (notification === undefined) {
      try {
        notification = notificationRepository.create({
          projectId: project.id,
          runId: run.id,
          channelId: channel.id,
          eventType,
          payload: card,
          dedupeKey,
          now: clock(),
        });
      } catch {
        notification = notificationRepository.findByDedupe(dedupeKey);
      }
    }

    if (notification === undefined) {
      result.failed += 1;
      continue;
    }

    let webhookUrl: string;
    let secret: string;

    try {
      webhookUrl = decryptChannel(options.cipher, options.tenantId, channel, 'webhook');
      secret = decryptChannel(options.cipher, options.tenantId, channel, 'secret');
    } catch (error) {
      const failed = notificationRepository.update(notification.id, {
        status: NOTIFICATION_STATUS.FAILED,
        responseBody: redactText(
          error instanceof Error ? error.message : 'Unable to decrypt channel secrets',
        ).slice(0, 300),
      });

      result.failed += 1;
      result.results.push({
        notificationId: notification.id,
        channelId: channel.id,
        eventType,
        status: failed?.status ?? NOTIFICATION_STATUS.FAILED,
        attempts: notification.attempts,
        error: { code: 'DECRYPT_FAILED', message: 'Unable to decrypt channel secrets' },
      });
      continue;
    }

    try {
      await urlSafety.assertRequestTarget(webhookUrl, { httpsOnly: true });
    } catch (error) {
      const code =
        error instanceof BlockedTargetError
          ? 'SSRF_BLOCKED'
          : error instanceof DnsResolutionError
            ? 'DNS_FAILURE'
            : 'INVALID_WEBHOOK';
      const failed = notificationRepository.update(notification.id, {
        status: NOTIFICATION_STATUS.FAILED,
        attempts: notification.attempts + 1,
        responseBody: `${code}: ${redactText(
          error instanceof Error ? error.message : 'Webhook rejected',
        ).slice(0, 300)}`,
      });

      result.failed += 1;
      result.results.push({
        notificationId: notification.id,
        channelId: channel.id,
        eventType,
        status: failed?.status ?? NOTIFICATION_STATUS.FAILED,
        attempts: notification.attempts + 1,
        error: { code, message: 'Webhook target rejected by SSRF guard' },
      });
      continue;
    }

    const delivered = await deliver({
      notification,
      channel,
      webhookUrl,
      secret,
      card,
      remainingAttempts: Math.max(
        1,
        ANALYSIS_LIMITS.MAX_NOTIFICATION_ATTEMPTS - notification.attempts,
      ),
      fetchImpl,
      now: clock,
      sleep,
      repository: notificationRepository,
      log,
    });

    result.results.push(delivered);

    if (delivered.status === NOTIFICATION_STATUS.SENT) {
      result.sent += 1;
    } else if (delivered.status === NOTIFICATION_STATUS.SKIPPED) {
      result.skipped += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}
