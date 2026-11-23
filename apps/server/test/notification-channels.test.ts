// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import { createFeishuSignature } from '../src/config/feishu.js';
import type { HttpClient, HttpRequestOptions } from '../src/config/http-client.js';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import {
  createNotificationChannel,
  createProject,
  PUBLIC_DNS_LOOKUP,
  seedActor,
} from './config-helpers.js';

async function withApp(
  run: (context: TestAppContext) => Promise<void>,
  options: Parameters<typeof createTestApp>[0] = {},
): Promise<void> {
  const context = await createTestApp(options);

  try {
    await run(context);
  } finally {
    await closeTestApp(context);
  }
}

async function projectActor(context: TestAppContext): Promise<{
  actor: Awaited<ReturnType<typeof seedActor>>;
  projectId: string;
}> {
  const actor = await seedActor(context, {
    slug: 'acme',
    username: 'owner',
    role: 'owner',
  });
  const projectId = (
    (await createProject(context, actor)).json() as {
      project: { id: string };
    }
  ).project.id;

  return { actor, projectId };
}

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef123456';
const SIGNING_SECRET = 'feishu-signing-secret';

interface RawChannelRow {
  webhook_ciphertext: Buffer;
  webhook_iv: Buffer;
  webhook_auth_tag: Buffer;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
}

async function rawChannel(context: TestAppContext, id: string): Promise<RawChannelRow> {
  const result = await context.database.pglite.query<{
    webhook_ciphertext: Uint8Array;
    webhook_iv: Uint8Array;
    webhook_auth_tag: Uint8Array;
    secret_ciphertext: Uint8Array;
    secret_iv: Uint8Array;
    secret_auth_tag: Uint8Array;
  }>(
    `SELECT webhook_ciphertext, webhook_iv, webhook_auth_tag,
            secret_ciphertext, secret_iv, secret_auth_tag
     FROM notification_channels WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error(`notification channel not found: ${id}`);
  }

  return {
    webhook_ciphertext: Buffer.from(row.webhook_ciphertext),
    webhook_iv: Buffer.from(row.webhook_iv),
    webhook_auth_tag: Buffer.from(row.webhook_auth_tag),
    secret_ciphertext: Buffer.from(row.secret_ciphertext),
    secret_iv: Buffer.from(row.secret_iv),
    secret_auth_tag: Buffer.from(row.secret_auth_tag),
  };
}

describe('notification channels', () => {
  it('encrypts webhook and secret, returns masks and supports rotation', async () => {
    await withApp(async (context) => {
      const { actor, projectId } = await projectActor(context);
      const created = await createNotificationChannel(context, actor, projectId);
      expect(created.statusCode).toBe(201);
      const channel = (
        created.json() as {
          channel: {
            id: string;
            maskedWebhook: string;
            events: string[];
            lastTestStatus: string;
          };
        }
      ).channel;
      expect(channel.maskedWebhook).toContain('https://open.feishu.cn/');
      expect(channel.maskedWebhook).toContain('****');
      expect(JSON.stringify(created.json())).not.toContain(WEBHOOK);
      expect(JSON.stringify(created.json())).not.toContain(SIGNING_SECRET);
      expect(channel.events).toEqual(['run_finished', 'run_failed']);
      expect(channel.lastTestStatus).toBe('unknown');

      const raw = await rawChannel(context, channel.id);
      expect(raw.webhook_ciphertext.toString('utf8')).not.toContain(WEBHOOK);
      expect(raw.secret_ciphertext.toString('utf8')).not.toContain(SIGNING_SECRET);
      expect(raw.webhook_iv).toHaveLength(12);
      expect(raw.secret_auth_tag).toHaveLength(16);

      const list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/notification-channels`,
        session: actor.session,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);
      expect(JSON.stringify(list.json())).not.toContain(WEBHOOK);

      const newWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/rotated9988';
      const updated = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/notification-channels/${channel.id}`,
        session: actor.session,
        payload: {
          webhookUrl: newWebhook,
          secret: 'rotated-signing-secret',
          events: ['daily_digest'],
          enabled: false,
        },
      });
      expect(updated.statusCode).toBe(200);
      const updatedBody = updated.json() as {
        channel: { maskedWebhook: string; events: string[]; enabled: boolean };
      };
      expect(updatedBody.channel.events).toEqual(['daily_digest']);
      expect(updatedBody.channel.enabled).toBe(false);
      expect(JSON.stringify(updatedBody)).not.toContain(newWebhook);
      const rotatedRaw = await rawChannel(context, channel.id);
      expect(rotatedRaw.webhook_ciphertext.equals(raw.webhook_ciphertext)).toBe(false);

      const auditRows = (
        await context.database.pglite.query<{ action: string; detail_json: string }>(
          'SELECT action, detail_json FROM audit_logs WHERE resource_id = $1 ORDER BY created_at',
          [channel.id],
        )
      ).rows;
      expect(auditRows.map((row) => row.action)).toEqual(
        expect.arrayContaining(['notification_channel.create', 'notification_channel.update']),
      );
      expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(SIGNING_SECRET);
      expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(newWebhook);

      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/notification-channels/${channel.id}`,
            session: actor.session,
          })
        ).statusCode,
      ).toBe(204);
    });
  });

  it('only accepts HTTPS Feishu/Lark webhooks and enforces permissions', async () => {
    await withApp(async (context) => {
      const { actor, projectId } = await projectActor(context);

      const httpUrl = await createNotificationChannel(context, actor, projectId, {
        name: 'HTTP',
        webhookUrl: 'http://open.feishu.cn/open-apis/bot/v2/hook/abc',
      });
      expect(httpUrl.statusCode).toBe(400);

      const slack = await createNotificationChannel(context, actor, projectId, {
        name: 'Slack',
        webhookUrl: 'https://hooks.slack.com/services/abc',
      });
      expect(slack.statusCode).toBe(400);

      const lark = await createNotificationChannel(context, actor, projectId, {
        name: 'Lark',
        webhookUrl: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc',
      });
      expect(lark.statusCode).toBe(201);

      const duplicate = await createNotificationChannel(context, actor, projectId, {
        name: 'Lark',
      });
      expect(duplicate.statusCode).toBe(400);

      const developer = await seedUser(context.database.db, {
        username: 'developer-user',
        tenantId: actor.tenant.id,
        role: 'developer',
      });
      expect(developer.id).toBeDefined();
      const developerSession = await login(context.app, 'developer-user', TEST_PASSWORD);
      expect(
        (
          await authedRequest(context.app, {
            method: 'GET',
            url: `/api/v1/projects/${projectId}/notification-channels`,
            session: developerSession,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await createNotificationChannel(
            context,
            { ...actor, session: developerSession },
            projectId,
            { name: 'Nope' },
          )
        ).statusCode,
      ).toBe(403);
    });
  });

  it('signs test cards and records success, API errors and network failures', async () => {
    const calls: HttpRequestOptions[] = [];
    let responseBody = '{"code":0,"msg":"success"}';
    let responseStatus = 200;
    const httpClient: HttpClient = async (options) => {
      calls.push(options);

      return {
        status: responseStatus,
        headers: { 'content-type': 'application/json' },
        bodyText: responseBody,
      };
    };
    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const channel = (await createNotificationChannel(context, actor, projectId)).json() as {
          channel: { id: string };
        };

        const tested = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/notification-channels/${channel.channel.id}/test`,
          session: actor.session,
        });
        expect(tested.statusCode).toBe(200);
        expect(tested.json()).toMatchObject({ status: 'ok', code: 'OK' });
        const call = calls[0];
        expect(call?.method).toBe('POST');
        expect(call?.url).toBe(WEBHOOK);
        const payload = JSON.parse(call?.body ?? '{}') as {
          timestamp: string;
          sign: string;
          msg_type: string;
          card: unknown;
        };
        expect(payload.msg_type).toBe('interactive');
        expect(payload.sign).toBe(createFeishuSignature(Number(payload.timestamp), SIGNING_SECRET));
        expect(JSON.stringify(tested.json())).not.toContain(SIGNING_SECRET);

        const stored = (
          await context.database.pglite.query<{
            last_test_status: string;
            last_tested_at: number | null;
          }>('SELECT last_test_status, last_tested_at FROM notification_channels WHERE id = $1', [
            channel.channel.id,
          ])
        ).rows[0];
        expect(stored?.last_test_status).toBe('success');
        expect(stored?.last_tested_at).not.toBeNull();

        responseBody = '{"code":19001,"msg":"param invalid"}';
        const apiError = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/notification-channels/${channel.channel.id}/test`,
          session: actor.session,
        });
        expect(apiError.statusCode).toBe(200);
        expect(apiError.json()).toMatchObject({
          status: 'failed',
          code: 'FEISHU_API_ERROR',
        });

        responseStatus = 500;
        responseBody = '{"msg":"server error"}';
        const httpError = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/notification-channels/${channel.channel.id}/test`,
          session: actor.session,
        });
        expect(httpError.json()).toMatchObject({ status: 'failed', code: 'HTTP_ERROR' });

        const failed = (
          await context.database.pglite.query<{ last_test_status: string }>(
            'SELECT last_test_status FROM notification_channels WHERE id = $1',
            [channel.channel.id],
          )
        ).rows[0];
        expect(failed?.last_test_status).toBe('failed');

        const auditRows = (
          await context.database.pglite.query<{ detail_json: string }>(
            "SELECT detail_json FROM audit_logs WHERE action = 'notification_channel.test'",
          )
        ).rows;
        expect(auditRows.length).toBe(3);
        expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(SIGNING_SECRET);
      },
      { httpClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );

    const failingClient: HttpClient = async () => {
      throw new Error('connection refused');
    };
    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const channel = (await createNotificationChannel(context, actor, projectId)).json() as {
          channel: { id: string };
        };
        const response = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/notification-channels/${channel.channel.id}/test`,
          session: actor.session,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: 'failed',
          code: 'NETWORK_ERROR',
        });
      },
      { httpClient: failingClient, dnsLookup: PUBLIC_DNS_LOOKUP },
    );
  });

  it('blocks private DNS targets before sending and hides foreign channels', async () => {
    let called = false;
    const httpClient: HttpClient = async () => {
      called = true;

      return { status: 200, headers: {}, bodyText: '{"code":0}' };
    };

    await withApp(
      async (context) => {
        const { actor, projectId } = await projectActor(context);
        const channel = (await createNotificationChannel(context, actor, projectId)).json() as {
          channel: { id: string };
        };
        const blocked = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/notification-channels/${channel.channel.id}/test`,
          session: actor.session,
        });
        expect(blocked.statusCode).toBe(400);
        expect((blocked.json() as { code: string }).code).toBe('SSRF_BLOCKED');
        expect(called).toBe(false);
      },
      {
        httpClient,
        dnsLookup: async () => [{ address: '10.0.0.9', family: 4 }],
      },
    );

    await withApp(async (context) => {
      const alpha = await seedActor(context, {
        slug: 'alpha',
        username: 'alpha-owner',
        role: 'owner',
      });
      const beta = await seedActor(context, {
        slug: 'beta',
        username: 'beta-owner',
        role: 'owner',
      });
      const alphaProject = (
        (await createProject(context, alpha)).json() as {
          project: { id: string };
        }
      ).project.id;
      const betaProject = (
        (await createProject(context, beta)).json() as {
          project: { id: string };
        }
      ).project.id;
      const channel = (await createNotificationChannel(context, alpha, alphaProject)).json() as {
        channel: { id: string };
      };

      for (const [method, url, payload] of [
        ['GET', `/api/v1/projects/${alphaProject}/notification-channels`, undefined],
        ['PATCH', `/api/v1/notification-channels/${channel.channel.id}`, { name: 'Hijack' }],
        ['DELETE', `/api/v1/notification-channels/${channel.channel.id}`, undefined],
        ['POST', `/api/v1/notification-channels/${channel.channel.id}/test`, undefined],
      ] as const) {
        const response = await authedRequest(context.app, {
          method,
          url,
          session: beta.session,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }

      const ownList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${betaProject}/notification-channels`,
        session: beta.session,
      });
      expect((ownList.json() as { items: unknown[] }).items).toHaveLength(0);
    });
  });
});
