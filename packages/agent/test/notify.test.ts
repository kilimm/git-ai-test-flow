// 本文件所有改动要求遵循 agent-rules 规范
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEncryptionKey, SecretCipher, UrlSafetyChecker } from '@gait/config';
import { loadEnv } from '@gait/config';
import { createTestDatabase } from '@gait/db/testing';
import type { TestDatabase } from '@gait/db/testing';
import {
  NotificationChannelRepository,
  NotificationRepository,
  ProjectRepository,
  RunRepository,
  TenantRepository,
} from '@gait/db';
import type { Project, Run, Tenant } from '@gait/db';
import { buildRunReport } from '../src/report/report-builder.js';
import {
  buildRunFeishuCard,
  createFeishuSignature,
  parseFeishuResponse,
} from '../src/notify/feishu.js';
import { notifyRun } from '../src/notify/notifier.js';

const databases: TestDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.cleanup();
  }
});

interface Fixture {
  database: TestDatabase;
  tenant: Tenant;
  project: Project;
  run: Run;
  cipher: SecretCipher;
  env: ReturnType<typeof loadEnv>;
}

async function seed(): Promise<Fixture> {
  const database = await createTestDatabase();
  databases.push(database);
  const tenant = await new TenantRepository(database.db).create({ slug: 'acme', name: 'Acme' });
  const project = await new ProjectRepository(database.db, tenant.id).create({
    name: 'Demo',
    slug: 'demo',
    productRepoUrl: 'https://example.com/demo.git',
    defaultBranch: 'main',
    suiteMode: 'external',
    suiteRepoUrl: 'https://example.com/suite.git',
    featureRoot: 'features/',
    docsRoot: 'docs/',
  });
  const run = await new RunRepository(database.db, tenant.id).create({
    projectId: project.id,
    headSha: 'a'.repeat(40),
    status: 'failed',
    idempotencyKey: `notify:${Math.random()}`,
  });
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    PUBLIC_BASE_URL: 'https://platform.example',
    SSRF_ALLOWLIST: 'open.feishu.cn',
    DATA_DIR: './data',
  });
  const cipher = new SecretCipher(
    createEncryptionKey(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION),
  );

  return { database, tenant, project, run, cipher, env };
}

async function addChannel(
  fixture: Fixture,
  options: {
    events?: string[];
    webhook?: string;
    secret?: string;
    enabled?: boolean;
    name?: string;
  } = {},
): Promise<string> {
  const id = `channel-${Math.random().toString(36).slice(2)}`;
  const webhook = options.webhook ?? 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token';
  const secret = options.secret ?? 'sign-secret';

  await new NotificationChannelRepository(fixture.database.db, fixture.tenant.id).create({
    id,
    projectId: fixture.project.id,
    name: options.name ?? `channel-${id}`,
    webhook: fixture.cipher.encrypt(fixture.tenant.id, id, 'feishu_webhook_url', webhook),
    secret: fixture.cipher.encrypt(fixture.tenant.id, id, 'feishu_sign_secret', secret),
    eventsJson: JSON.stringify(options.events ?? ['run_finished', 'run_failed']),
    enabled: options.enabled ?? true,
  });

  return id;
}

function response(status: number, body: string): Response {
  return {
    status,
    text: async () => body,
  } as Response;
}

describe('飞书通知', () => {
  it('发送签名卡片并记录成功状态', async () => {
    const fixture = await seed();
    const channelId = await addChannel(fixture, { secret: 'my-secret' });
    const calls: { body: Record<string, unknown>; url: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });

      return response(200, '{"code":0,"msg":"ok"}');
    }) as typeof fetch;

    const result = await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
    });
    const notifications = await new NotificationRepository(
      fixture.database.db,
      fixture.tenant.id,
    ).listByRun(fixture.run.id);

    expect(result.sent).toBe(1);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      timestamp: string;
      sign: string;
      msg_type: string;
      card: { header: { template: string } };
    };

    expect(body.msg_type).toBe('interactive');
    expect(body.timestamp).toBe('1700000000');
    expect(body.sign).toBe(createFeishuSignature(1_700_000_000, 'my-secret'));
    expect(body.card.header.template).toBe('red');
    expect(notifications[0]?.status).toBe('sent');
    expect(notifications[0]?.attempts).toBe(1);
    expect(notifications[0]?.dedupeKey).toBe(`${fixture.run.id}:${channelId}:run_failed`);
  });

  it('发送成功后落库失败不会再次发送', async () => {
    const fixture = await seed();

    await addChannel(fixture);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return response(200, '{"code":0}');
    }) as typeof fetch;
    const spy = vi
      .spyOn(NotificationRepository.prototype, 'update')
      .mockRejectedValueOnce(new Error('db write failed'));

    try {
      await expect(
        notifyRun({
          db: fixture.database.db,
          tenantId: fixture.tenant.id,
          runId: fixture.run.id,
          env: fixture.env,
          cipher: fixture.cipher,
          fetchImpl,
          now: () => Date.now(),
          sleep: async () => undefined,
        }),
      ).rejects.toThrow('db write failed');
    } finally {
      spy.mockRestore();
    }

    // 数据库抖动不能被当作网络失败重试，否则会给飞书重复推送同一张卡片。
    expect(calls).toBe(1);
  });

  it('同一 Run 同一渠道重复通知只发送一次', async () => {
    const fixture = await seed();

    await addChannel(fixture);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return response(200, '{"code":0}');
    }) as typeof fetch;
    const options = {
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => undefined,
    };

    await notifyRun(options);
    const second = await notifyRun(options);

    expect(calls).toBe(1);
    expect(second.skipped).toBe(1);
  });

  it('失败重试 3 次后记录失败并停止重试', async () => {
    const fixture = await seed();

    await addChannel(fixture);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return response(500, '{"code":19001,"msg":"boom"}');
    }) as typeof fetch;
    const result = await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => undefined,
    });
    const notifications = await new NotificationRepository(
      fixture.database.db,
      fixture.tenant.id,
    ).listByRun(fixture.run.id);

    expect(result.failed).toBe(1);
    expect(calls).toBe(3);
    expect(notifications[0]?.status).toBe('failed');
    expect(notifications[0]?.attempts).toBe(3);
    expect(notifications[0]?.responseStatus).toBe(500);

    const again = await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => undefined,
    });

    expect(again.skipped).toBe(1);
    expect(calls).toBe(3);
  });

  it('通知响应中的敏感字段落库前脱敏', async () => {
    const fixture = await seed();

    await addChannel(fixture);
    const fetchImpl = (async () =>
      response(200, '{"code":0,"token":"super-secret-token"}')) as typeof fetch;

    await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => undefined,
    });
    const notifications = await new NotificationRepository(
      fixture.database.db,
      fixture.tenant.id,
    ).listByRun(fixture.run.id);

    expect(notifications[0]?.responseBody).toContain('****');
    expect(notifications[0]?.responseBody).not.toContain('super-secret-token');
  });

  it('未订阅的 Run 事件不发送', async () => {
    const fixture = await seed();

    await addChannel(fixture, { events: ['daily_digest'] });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return response(200, '{"code":0}');
    }) as typeof fetch;
    const result = await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
    });

    expect(result.skipped).toBe(1);
    expect(calls).toBe(0);
  });

  it('SSRF 拦截内网 Webhook', async () => {
    const fixture = await seed();

    await addChannel(fixture, { webhook: 'https://127.0.0.1/hook' });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return response(200, '{"code":0}');
    }) as typeof fetch;
    const result = await notifyRun({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      env: fixture.env,
      cipher: fixture.cipher,
      fetchImpl,
    });

    expect(result.failed).toBe(1);
    expect(calls).toBe(0);
  });

  it('卡片包含通过率、失败数与深链', async () => {
    const fixture = await seed();
    const report = await buildRunReport({
      db: fixture.database.db,
      tenantId: fixture.tenant.id,
      runId: fixture.run.id,
      baseUrl: 'https://platform.example',
    });
    const card = buildRunFeishuCard(report) as {
      header: { template: string };
      elements: { content?: string; actions?: { url?: string }[] }[];
    };
    const content = card.elements.map((element) => element.content ?? '').join('\n');

    expect(card.header.template).toBe('red');
    expect(content).toContain('通过率');
    expect(card.elements.some((element) => element.actions?.[0]?.url?.includes('/runs/'))).toBe(
      true,
    );
  });

  it('解析飞书 API 错误响应', () => {
    expect(parseFeishuResponse(200, '{"code":0}').ok).toBe(true);
    expect(parseFeishuResponse(200, '{"code":19001,"msg":"invalid sign"}')).toMatchObject({
      ok: false,
      code: 'FEISHU_API_ERROR',
    });
    expect(parseFeishuResponse(500, 'oops')).toMatchObject({ ok: false });
  });

  it('显式 UrlSafetyChecker 允许合法域名', async () => {
    const checker = new UrlSafetyChecker({ allowlist: ['open.feishu.cn'] });

    await expect(
      checker.assertRequestTarget('https://open.feishu.cn/open-apis/bot/v2/hook/x', {
        httpsOnly: true,
      }),
    ).resolves.toBeInstanceOf(URL);
  });
});
