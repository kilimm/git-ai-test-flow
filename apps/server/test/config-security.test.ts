// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { TestDatabase } from '@gait/db/testing';
import { authedRequest, closeTestApp, createTestApp } from './helpers.js';
import {
  createCredential,
  createEnvironment,
  createLlmProfile,
  createNotificationChannel,
  createProject,
  seedActor,
} from './config-helpers.js';

const SECRETS = {
  git: 'ghp_plaintext_leak_check_1111',
  llm: 'sk-plaintext-leak-check-2222',
  testAccount: 'testaccount-plaintext-3333',
  database: 'dbpassword-plaintext-4444',
  webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/plaintextwebhook5555',
  channelSecret: 'feishu-plaintext-secret-6666',
} as const;

const ALL_SECRETS = Object.values(SECRETS);

function assertNoPlaintext(
  database: TestDatabase,
  values: readonly string[],
  context: string,
): void {
  const tables = database.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  for (const table of tables) {
    const rows = database.sqlite.prepare(`SELECT * FROM "${table.name}"`).all() as Array<
      Record<string, unknown>
    >;

    for (const row of rows) {
      for (const [column, raw] of Object.entries(row)) {
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : typeof raw === 'string'
            ? raw
            : JSON.stringify(raw);

        for (const secret of values) {
          expect(
            text.includes(secret),
            `${context}: ${table.name}.${column} contains a plaintext secret`,
          ).toBe(false);
        }
      }
    }
  }
}

describe('configuration security', () => {
  it('never stores or returns configured secrets in plaintext', async () => {
    const context = await createTestApp();

    try {
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

      const gitCredential = (
        await createCredential(context, actor, projectId, {
          name: 'Git',
          secret: SECRETS.git,
        })
      ).json() as { credential: { id: string } };
      const llmCredential = (
        await createCredential(context, actor, projectId, {
          name: 'LLM',
          type: 'llm_api_key',
          secret: SECRETS.llm,
        })
      ).json() as { credential: { id: string } };
      const testAccount = (
        await createCredential(context, actor, projectId, {
          name: 'Test Account',
          type: 'test_account',
          username: 'qa-user',
          secret: SECRETS.testAccount,
        })
      ).json() as { credential: { id: string } };
      const databaseCredential = (
        await createCredential(context, actor, projectId, {
          name: 'DB Password',
          type: 'db_password',
          secret: SECRETS.database,
        })
      ).json() as { credential: { id: string } };

      await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
        payload: { gitCredentialId: gitCredential.credential.id },
      });
      await createLlmProfile(context, actor, projectId, {
        credentialId: llmCredential.credential.id,
      });
      const environment = await createEnvironment(context, actor, projectId, {
        name: 'secure-env',
        testAccountCredentialId: testAccount.credential.id,
        db: {
          type: 'postgresql',
          host: 'db.example.com',
          port: 5432,
          name: 'app_test',
          user: 'tester',
          credentialId: databaseCredential.credential.id,
          isTest: true,
          writeMode: 'readonly',
        },
      });
      expect(environment.statusCode).toBe(201);
      const channel = await createNotificationChannel(context, actor, projectId, {
        webhookUrl: SECRETS.webhook,
        secret: SECRETS.channelSecret,
      });
      expect(channel.statusCode).toBe(201);

      const endpoints = [
        `/api/v1/projects/${projectId}/credentials`,
        `/api/v1/projects/${projectId}/llm-profiles`,
        `/api/v1/projects/${projectId}/environments`,
        `/api/v1/projects/${projectId}/notification-channels`,
        `/api/v1/projects/${projectId}`,
        '/api/v1/audit-logs?limit=100',
      ];

      for (const url of endpoints) {
        const response = await authedRequest(context.app, {
          method: 'GET',
          url,
          session: actor.session,
        });
        expect(response.statusCode, url).toBe(200);

        const serialized = JSON.stringify(response.json());
        for (const secret of ALL_SECRETS) {
          expect(serialized.includes(secret), `${url} leaks a plaintext secret`).toBe(false);
        }
      }

      assertNoPlaintext(context.database, ALL_SECRETS, 'database');

      // 掩码仍然可用于识别凭据，但不能还原原文。
      const credentialsList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/credentials`,
        session: actor.session,
      });
      const masks = (
        credentialsList.json() as {
          items: Array<{ maskedSecret: string }>;
        }
      ).items.map((item) => item.maskedSecret);
      expect(masks.every((mask) => mask.includes('****'))).toBe(true);

      const auditActions = context.database.sqlite
        .prepare("SELECT DISTINCT action FROM audit_logs WHERE resource_type != 'session'")
        .all() as Array<{ action: string }>;
      expect(auditActions.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'project.update',
          'credential.create',
          'llm_profile.create',
          'environment.create',
          'notification_channel.create',
        ]),
      );
    } finally {
      await closeTestApp(context);
    }
  });

  it('does not trust tenant identifiers from query parameters', async () => {
    const context = await createTestApp();

    try {
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
      const betaProjectId = (
        (await createProject(context, beta)).json() as {
          project: { id: string };
        }
      ).project.id;

      // 用租户 B 的会话访问 A 的列表：路径租户不匹配直接 404。
      const pathMismatch = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/tenants/${alpha.tenant.id}/projects?tenantId=${beta.tenant.id}`,
        session: beta.session,
      });
      expect(pathMismatch.statusCode).toBe(404);

      // 查询参数中的 tenantId 不能改变数据归属。
      const withQuery = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${betaProjectId}?tenantId=${alpha.tenant.id}`,
        session: beta.session,
      });
      expect(withQuery.statusCode).toBe(200);
      const body = withQuery.json() as { project: { slug: string } };
      expect(body.project.slug).toBe('demo');
      expect(
        context.database.sqlite
          .prepare('SELECT tenant_id FROM projects WHERE id = ?')
          .get(betaProjectId),
      ).toEqual({ tenant_id: beta.tenant.id });
    } finally {
      await closeTestApp(context);
    }
  });
});
