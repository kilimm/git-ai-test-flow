// 本文件所有改动要求遵循 agent-rules 规范
import { count } from 'drizzle-orm';
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
import { credentials, environments, llmProfiles, notificationChannels } from '../src/schema.js';
import { createTestDatabase } from '../src/testing.js';
import type { TestDatabase } from '../src/testing.js';
import type { EncryptedSecret } from '../src/repositories/credential-repository.js';

const SECRET: EncryptedSecret = {
  ciphertext: Buffer.from('ciphertext'),
  iv: Buffer.alloc(12, 1),
  authTag: Buffer.alloc(16, 2),
  keyVersion: 1,
};

async function createUser(database: TestDatabase, username: string): Promise<string> {
  const user = await new UserRepository(database.db).create({
    username,
    email: null,
    passwordHash: 'hash',
    displayName: username,
  });

  return user.id;
}

describe('configuration repositories', () => {
  it('scopes all resources by tenant and cascades project children', async () => {
    const database = await createTestDatabase();

    try {
      const tenantA = await new TenantRepository(database.db).create({
        slug: 'tenant-a',
        name: 'A',
      });
      const tenantB = await new TenantRepository(database.db).create({
        slug: 'tenant-b',
        name: 'B',
      });
      const userId = await createUser(database, 'owner');
      const projectsA = new ProjectRepository(database.db, tenantA.id);
      const projectsB = new ProjectRepository(database.db, tenantB.id);
      const project = await projectsA.create({
        name: 'Project A',
        slug: 'project-a',
        productRepoUrl: 'https://github.com/acme/a.git',
        defaultBranch: 'main',
        suiteMode: 'managed',
        featureRoot: 'features/',
        docsRoot: 'docs/ai/',
        createdByUserId: userId,
      });

      expect(await projectsB.findById(project.id)).toBeUndefined();
      expect(await projectsB.list()).toHaveLength(0);
      expect(await projectsA.list()).toHaveLength(1);

      const credentialsRepository = new CredentialRepository(database.db, tenantA.id);
      const credential = await credentialsRepository.create({
        name: 'Token',
        type: 'git_pat',
        secret: SECRET,
        createdByUserId: userId,
      });
      expect(
        await new CredentialRepository(database.db, tenantB.id).findById(credential.id),
      ).toBeUndefined();
      expect(
        (await projectsA.update(project.id, { gitCredentialId: credential.id }))?.gitCredentialId,
      ).toBe(credential.id);
      expect(await projectsA.countByCredential(credential.id)).toBe(1);

      const llm = await new LlmProfileRepository(database.db, tenantA.id).create({
        projectId: project.id,
        name: 'Generation',
        purpose: 'generation',
        provider: 'openai-compatible',
        baseUrl: 'https://llm.example.com/v1',
        model: 'model',
        credentialId: credential.id,
      });
      const environmentsRepository = new EnvironmentRepository(database.db, tenantA.id);
      const environment = await environmentsRepository.create({
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
      const secondEnvironment = await environmentsRepository.create({
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
      expect(await environmentsRepository.countByCredential(credential.id)).toBe(1);
      expect(
        await new LlmProfileRepository(database.db, tenantA.id).countByCredential(credential.id),
      ).toBe(1);

      const channelRepository = new NotificationChannelRepository(database.db, tenantA.id);
      const channel = await channelRepository.create({
        projectId: project.id,
        name: 'Bot',
        webhook: SECRET,
        secret: SECRET,
        eventsJson: '["run_finished"]',
        enabled: true,
      });
      expect(
        await channelRepository.update(channel.id, {
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
        await new NotificationChannelRepository(database.db, tenantB.id).findById(channel.id),
      ).toBeUndefined();

      await environmentsRepository.clearDefault(project.id, secondEnvironment.id);
      expect((await environmentsRepository.findById(environment.id))?.isDefault).toBe(false);
      expect((await environmentsRepository.findById(secondEnvironment.id))?.isDefault).toBe(true);

      await projectsA.remove(project.id);
      expect((await database.db.select({ value: count() }).from(llmProfiles))[0]?.value).toBe(0);
      expect((await database.db.select({ value: count() }).from(environments))[0]?.value).toBe(0);
      expect(
        (await database.db.select({ value: count() }).from(notificationChannels))[0]?.value,
      ).toBe(0);
      expect((await database.db.select({ value: count() }).from(credentials))[0]?.value).toBe(1);
      expect(llm.id).toBeDefined();
    } finally {
      await database.cleanup();
    }
  });
});
