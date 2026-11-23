// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import type { GitLsRemoteInput } from '../src/config/git-client.js';
import {
  authedRequest,
  closeTestApp,
  createTestApp,
  login,
  seedUser,
  TEST_PASSWORD,
} from './helpers.js';
import type { TestAppContext } from './helpers.js';
import { createCredential, createLlmProfile, createProject, seedActor } from './config-helpers.js';

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

const GIT_SECRET = 'ghp_super_secret_token_123456';

interface RawCredentialRow {
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  key_version: number;
  type: string;
}

async function rawCredential(context: TestAppContext, id: string): Promise<RawCredentialRow> {
  const result = await context.database.pglite.query<{
    secret_ciphertext: Uint8Array;
    secret_iv: Uint8Array;
    secret_auth_tag: Uint8Array;
    key_version: number;
    type: string;
  }>(
    'SELECT secret_ciphertext, secret_iv, secret_auth_tag, key_version, type FROM credentials WHERE id = $1',
    [id],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error(`credential not found: ${id}`);
  }

  return {
    secret_ciphertext: Buffer.from(row.secret_ciphertext),
    secret_iv: Buffer.from(row.secret_iv),
    secret_auth_tag: Buffer.from(row.secret_auth_tag),
    key_version: row.key_version,
    type: row.type,
  };
}

describe('credentials', () => {
  it('stores encrypted secrets, returns masks, rotates and deletes', async () => {
    await withApp(async (context) => {
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
      const created = await createCredential(context, actor, projectId, {
        name: 'Git Token',
        secret: GIT_SECRET,
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
      expect(created.statusCode).toBe(201);
      const credential = (
        created.json() as {
          credential: {
            id: string;
            maskedSecret: string;
            expiresAt: string;
          };
        }
      ).credential;
      expect(credential.maskedSecret).not.toContain(GIT_SECRET);
      expect(credential.maskedSecret).toContain('****');
      expect(credential.expiresAt).toBe('2027-01-01T00:00:00.000Z');
      expect(JSON.stringify(created.json())).not.toContain(GIT_SECRET);

      const raw = await rawCredential(context, credential.id);
      expect(raw.secret_ciphertext.toString('utf8')).not.toContain(GIT_SECRET);
      expect(raw.secret_iv).toHaveLength(12);
      expect(raw.secret_auth_tag).toHaveLength(16);
      expect(raw.key_version).toBe(1);

      const list = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/credentials`,
        session: actor.session,
      });
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toContain(GIT_SECRET);

      const rotatedSecret = 'ghp_rotated_secret_abcdef';
      const updated = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/credentials/${credential.id}`,
        session: actor.session,
        payload: {
          name: 'Git Token v2',
          secret: rotatedSecret,
          username: null,
          expiresAt: null,
        },
      });
      expect(updated.statusCode).toBe(200);
      const updatedCredential = (
        updated.json() as {
          credential: { maskedSecret: string; username: string | null; expiresAt: string | null };
        }
      ).credential;
      expect(updatedCredential.maskedSecret).not.toContain(rotatedSecret);
      expect(updatedCredential.username).toBeNull();
      expect(updatedCredential.expiresAt).toBeNull();
      const rotatedRaw = await rawCredential(context, credential.id);
      expect(rotatedRaw.secret_ciphertext.equals(raw.secret_ciphertext)).toBe(false);

      const typeChange = await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/credentials/${credential.id}`,
        session: actor.session,
        payload: { type: 'llm_api_key' },
      });
      expect(typeChange.statusCode).toBe(400);

      const auditRows = (
        await context.database.pglite.query<{ action: string; detail_json: string }>(
          'SELECT action, detail_json FROM audit_logs WHERE resource_id = $1 ORDER BY created_at',
          [credential.id],
        )
      ).rows;
      expect(auditRows.map((row) => row.action)).toEqual(
        expect.arrayContaining(['credential.create', 'credential.update']),
      );
      expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(GIT_SECRET);
      expect(auditRows.map((row) => row.detail_json).join('')).not.toContain(rotatedSecret);
      expect(auditRows.map((row) => row.detail_json).join('')).toContain('"rotated":true');

      const removed = await authedRequest(context.app, {
        method: 'DELETE',
        url: `/api/v1/credentials/${credential.id}`,
        session: actor.session,
      });
      expect(removed.statusCode).toBe(204);
      const removedCredential = await context.database.pglite.query<{ id: string }>(
        'SELECT id FROM credentials WHERE id = $1',
        [credential.id],
      );
      expect(removedCredential.rows[0]).toBeUndefined();
    });
  });

  it('blocks deletion while referenced by projects or LLM profiles', async () => {
    await withApp(async (context) => {
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
      const gitCredential = (await createCredential(context, actor, projectId)).json() as {
        credential: { id: string };
      };
      const llmCredential = (
        await createCredential(context, actor, projectId, {
          name: 'LLM Key',
          type: 'llm_api_key',
          secret: 'sk-llm-secret-123456',
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

      const gitDelete = await authedRequest(context.app, {
        method: 'DELETE',
        url: `/api/v1/credentials/${gitCredential.credential.id}`,
        session: actor.session,
      });
      expect(gitDelete.statusCode).toBe(409);
      expect((gitDelete.json() as { code: string }).code).toBe('CREDENTIAL_IN_USE');

      const llmDelete = await authedRequest(context.app, {
        method: 'DELETE',
        url: `/api/v1/credentials/${llmCredential.credential.id}`,
        session: actor.session,
      });
      expect(llmDelete.statusCode).toBe(409);

      await authedRequest(context.app, {
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}`,
        session: actor.session,
        payload: { gitCredentialId: null },
      });
      const profiles = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${projectId}/llm-profiles`,
        session: actor.session,
      });
      const profileId = (profiles.json() as { items: Array<{ id: string }> }).items[0]?.id;

      if (profileId !== undefined) {
        await authedRequest(context.app, {
          method: 'DELETE',
          url: `/api/v1/llm-profiles/${profileId}`,
          session: actor.session,
        });
      }

      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/credentials/${gitCredential.credential.id}`,
            session: actor.session,
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await authedRequest(context.app, {
            method: 'DELETE',
            url: `/api/v1/credentials/${llmCredential.credential.id}`,
            session: actor.session,
          })
        ).statusCode,
      ).toBe(204);
    });
  });

  it('tests Git credentials with the stored token and rejects non-Git types', async () => {
    const calls: GitLsRemoteInput[] = [];
    await withApp(
      async (context) => {
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
        const credential = (
          await createCredential(context, actor, projectId, {
            secret: GIT_SECRET,
          })
        ).json() as {
          credential: { id: string };
        };

        await authedRequest(context.app, {
          method: 'PATCH',
          url: `/api/v1/projects/${projectId}`,
          session: actor.session,
          payload: { gitCredentialId: credential.credential.id },
        });

        const tested = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/credentials/${credential.credential.id}/test`,
          session: actor.session,
        });
        expect(tested.statusCode).toBe(200);
        expect((tested.json() as { status: string }).status).toBe('ok');
        expect(calls[0]?.token).toBe(GIT_SECRET);
        expect(calls[0]?.repoUrl).toBe('https://github.com/acme/demo.git');
        expect(JSON.stringify(tested.json())).not.toContain(GIT_SECRET);

        const override = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/credentials/${credential.credential.id}/test`,
          session: actor.session,
          payload: { repoUrl: 'https://github.com/acme/other.git' },
        });
        expect(override.statusCode).toBe(200);
        expect(calls[1]?.repoUrl).toBe('https://github.com/acme/other.git');

        const llmCredential = (
          await createCredential(context, actor, projectId, {
            name: 'LLM Key',
            type: 'llm_api_key',
            secret: 'sk-llm-secret-123456',
          })
        ).json() as { credential: { id: string } };
        const notGit = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/credentials/${llmCredential.credential.id}/test`,
          session: actor.session,
        });
        expect(notGit.statusCode).toBe(400);

        const orphan = (
          await createCredential(context, actor, projectId, {
            name: 'Unused Git Token',
            secret: 'ghp_unused_token_987654',
          })
        ).json() as { credential: { id: string } };
        const missingRepo = await authedRequest(context.app, {
          method: 'POST',
          url: `/api/v1/credentials/${orphan.credential.id}/test`,
          session: actor.session,
        });
        expect(missingRepo.statusCode).toBe(400);

        const testAudit = (
          await context.database.pglite.query<{ detail_json: string }>(
            "SELECT detail_json FROM audit_logs WHERE action = 'credential.test'",
          )
        ).rows;
        expect(testAudit.length).toBeGreaterThanOrEqual(2);
        expect(testAudit.map((row) => row.detail_json).join('')).not.toContain(GIT_SECRET);
      },
      {
        gitLsRemote: async (input) => {
          calls.push(input);

          return { ok: true, code: 'OK', message: 'ok', durationMs: 1 };
        },
      },
    );
  });

  it('enforces permissions and tenant isolation', async () => {
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
      const betaProjectId = (
        (await createProject(context, beta)).json() as {
          project: { id: string };
        }
      ).project.id;
      const credential = (await createCredential(context, alpha, alphaProject)).json() as {
        credential: { id: string };
      };

      const developer = await seedUser(context.database.db, {
        username: 'developer-user',
        tenantId: alpha.tenant.id,
        role: 'developer',
      });
      expect(developer.id).toBeDefined();
      const developerSession = await login(context.app, 'developer-user', TEST_PASSWORD);

      const readDenied = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${alphaProject}/credentials`,
        session: developerSession,
      });
      expect(readDenied.statusCode).toBe(403);
      const writeDenied = await createCredential(
        context,
        {
          ...alpha,
          session: developerSession,
        },
        alphaProject,
        { name: 'Nope' },
      );
      expect(writeDenied.statusCode).toBe(403);

      const betaList = await authedRequest(context.app, {
        method: 'GET',
        url: `/api/v1/projects/${betaProjectId}/credentials`,
        session: beta.session,
      });
      expect((betaList.json() as { items: unknown[] }).items).toHaveLength(0);

      for (const [method, url, payload] of [
        ['PATCH', `/api/v1/credentials/${credential.credential.id}`, { name: 'Hijack' }],
        ['DELETE', `/api/v1/credentials/${credential.credential.id}`, undefined],
        ['POST', `/api/v1/credentials/${credential.credential.id}/test`, undefined],
        ['GET', `/api/v1/projects/${alphaProject}/credentials`, undefined],
      ] as const) {
        const response = await authedRequest(context.app, {
          method,
          url,
          session: beta.session,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });
  });
});
