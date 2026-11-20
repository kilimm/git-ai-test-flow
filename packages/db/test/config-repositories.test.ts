// 本文件所有改动要求遵循 agent-rules 规范
import { describe, expect, it } from 'vitest';
import {
  CredentialRepository,
  EnvironmentRepository,
  LlmProfileRepository,
  NotificationChannelRepository,
  ProjectRepository,
  TenantRepository,
  UserRepository,
} from '../src/index.js';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';
import type { EncryptedSecret } from '../src/repositories/credential-repository.js';

const SECRET: EncryptedSecret = {
  ciphertext: Buffer.from('ciphertext'),
  iv: Buffer.alloc(12, 1),
  authTag: Buffer.alloc(16, 2),
  keyVersion: 1,
};

function createUser(database: TestDatabase, username: string): string {
  return new UserRepository(database.db).create({
    username,
    email: null,
    passwordHash: 'hash',
    displayName: username,
  }).id;
}

describe('configuration repositories', () => {
  it('scopes all resources by tenant and cascades project children', () => {
    const database = createTestDatabase();

    try {
      const tenantA = new TenantRepository(database.db).create({ slug: 'tenant-a', name: 'A' });
      const tenantB = new TenantRepository(database.db).create({ slug: 'tenant-b', name: 'B' });
      const userId = createUser(database, 'owner');
      const projectsA = new ProjectRepository(database.db, tenantA.id);
      const projectsB = new ProjectRepository(database.db, tenantB.id);
      const project = projectsA.create({
        name: 'Project A',
        slug: 'project-a',
        productRepoUrl: 'https://github.com/acme/a.git',
        defaultBranch: 'main',
        suiteMode: 'managed',
        featureRoot: 'features/',
        docsRoot: 'docs/ai/',
        createdByUserId: userId,
      });

      expect(projectsB.findById(project.id)).toBeUndefined();
      expect(projectsB.list()).toHaveLength(0);
      expect(projectsA.list()).toHaveLength(1);

      const credentials = new CredentialRepository(database.db, tenantA.id);
      const credential = credentials.create({
        name: 'Token',
        type: 'git_pat',
        secret: SECRET,
        createdByUserId: userId,
      });
      expect(
        new CredentialRepository(database.db, tenantB.id).findById(credential.id),
      ).toBeUndefined();
      expect(
        projectsA.update(project.id, { gitCredentialId: credential.id })?.gitCredentialId,
      ).toBe(credential.id);
      expect(projectsA.countByCredential(credential.id)).toBe(1);

      const llm = new LlmProfileRepository(database.db, tenantA.id).create({
        projectId: project.id,
        name: 'Generation',
        purpose: 'generation',
        provider: 'openai-compatible',
        baseUrl: 'https://llm.example.com/v1',
        model: 'model',
        credentialId: credential.id,
      });
      const environments = new EnvironmentRepository(database.db, tenantA.id);
      const environment = environments.create({
        projectId: project.id,
        name: 'staging',
        apiBaseUrl: 'https://api.example.com',
        healthcheckExpectedStatus: 200,
        healthcheckTimeoutMs: 5_000,
        versionSource: 'manual',
        strictVersionMatch: false,
        envVarsJson: '{}',
        browserJson: '{}',
        caseTimeoutMs: 60_000,
        apiConcurrency: 4,
        uiConcurrency: 1,
        isDefault: true,
        testAccountCredentialId: credential.id,
      });
      const secondEnvironment = environments.create({
        projectId: project.id,
        name: 'preprod',
        apiBaseUrl: 'https://preprod.example.com',
        healthcheckExpectedStatus: 200,
        healthcheckTimeoutMs: 5_000,
        versionSource: 'manual',
        strictVersionMatch: false,
        envVarsJson: '{}',
        browserJson: '{}',
        caseTimeoutMs: 60_000,
        apiConcurrency: 2,
        uiConcurrency: 1,
        isDefault: true,
      });
      expect(environments.countByCredential(credential.id)).toBe(1);
      expect(
        new LlmProfileRepository(database.db, tenantA.id).countByCredential(credential.id),
      ).toBe(1);

      const channelRepository = new NotificationChannelRepository(database.db, tenantA.id);
      const channel = channelRepository.create({
        projectId: project.id,
        name: 'Bot',
        webhook: SECRET,
        secret: SECRET,
        eventsJson: '["run_finished"]',
        enabled: true,
      });
      expect(
        channelRepository.update(channel.id, {
          enabled: false,
          lastTestedAt: 123,
          lastTestStatus: 'success',
          lastTestMessage: 'ok',
        }),
      ).toMatchObject({
        enabled: false,
        lastTestedAt: 123,
        lastTestStatus: 'success',
      });
      expect(
        new NotificationChannelRepository(database.db, tenantB.id).findById(channel.id),
      ).toBeUndefined();

      environments.clearDefault(project.id, secondEnvironment.id);
      expect(environments.findById(environment.id)?.isDefault).toBe(false);
      expect(environments.findById(secondEnvironment.id)?.isDefault).toBe(true);

      projectsA.remove(project.id);
      expect(database.sqlite.prepare('SELECT count(*) AS n FROM llm_profiles').get()).toEqual({
        n: 0,
      });
      expect(database.sqlite.prepare('SELECT count(*) AS n FROM environments').get()).toEqual({
        n: 0,
      });
      expect(
        database.sqlite.prepare('SELECT count(*) AS n FROM notification_channels').get(),
      ).toEqual({ n: 0 });
      expect(database.sqlite.prepare('SELECT count(*) AS n FROM credentials').get()).toEqual({
        n: 1,
      });
      expect(llm.id).toBeDefined();
    } finally {
      database.cleanup();
    }
  });
});
