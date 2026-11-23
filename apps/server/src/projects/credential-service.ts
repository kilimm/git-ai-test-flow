// 本文件所有改动要求遵循 agent-rules 规范
import { NotFoundError, ValidationError, uuidv7 } from '@gait/config';
import {
  CredentialRepository,
  EnvironmentRepository,
  LlmProfileRepository,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, Credential } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE } from '@gait/shared';
import type { CredentialType } from '@gait/shared';
import type { CreateCredentialBody, UpdateCredentialBody } from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
import { maskSecret } from '../config/secrets.js';
import type { ConfigServiceDeps } from './support.js';
import { configError, parseEpochOrNull, requireProject, writeConfigAudit } from './support.js';

export interface CredentialView {
  id: string;
  name: string;
  type: CredentialType;
  username: string | null;
  maskedSecret: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialTestResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  durationMs: number;
}

/** 凭据属于租户，可被多个项目复用；明文只在服务内存中出现。 */
export class CredentialService {
  constructor(
    private readonly db: AppDatabase,
    private readonly deps: ConfigServiceDeps,
  ) {}

  private decryptSecret(context: AuthContext, credential: Credential): string {
    return this.deps.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
      ciphertext: credential.secretCiphertext,
      iv: credential.secretIv,
      authTag: credential.secretAuthTag,
      keyVersion: credential.keyVersion,
    });
  }

  private view(context: AuthContext, credential: Credential): CredentialView {
    return {
      id: credential.id,
      name: credential.name,
      type: credential.type,
      username: credential.username,
      maskedSecret: maskSecret(this.decryptSecret(context, credential)),
      expiresAt:
        credential.expiresAt === null ? null : new Date(credential.expiresAt).toISOString(),
      createdAt: new Date(credential.createdAt).toISOString(),
      updatedAt: new Date(credential.updatedAt).toISOString(),
    };
  }

  async create(
    context: AuthContext,
    projectId: string,
    input: CreateCredentialBody,
  ): Promise<CredentialView> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const repository = new CredentialRepository(this.db, context.tenant.id);

    if ((await repository.findByName(input.name)) !== undefined) {
      throw new ValidationError('Credential name already exists');
    }

    const now = this.deps.now();
    const id = uuidv7(now);
    const credential = await repository.create({
      id,
      name: input.name,
      type: input.type,
      username: input.username ?? null,
      secret: this.deps.cipher.encrypt(context.tenant.id, id, input.type, input.secret),
      expiresAt: parseEpochOrNull(input.expiresAt) ?? null,
      createdByUserId: context.user.id,
      now,
    });

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.CREDENTIAL_CREATE,
      AUDIT_RESOURCE_TYPE.CREDENTIAL,
      credential.id,
      { name: credential.name, type: credential.type },
    );

    return this.view(context, credential);
  }

  async list(context: AuthContext, projectId: string): Promise<CredentialView[]> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const credentials = await new CredentialRepository(this.db, context.tenant.id).list();

    return credentials.map((credential) => this.view(context, credential));
  }

  private async requireExisting(context: AuthContext, credentialId: string): Promise<Credential> {
    const credential = await new CredentialRepository(this.db, context.tenant.id).findById(
      credentialId,
    );

    if (credential === undefined) {
      throw new NotFoundError('Credential not found');
    }

    return credential;
  }

  async update(
    context: AuthContext,
    credentialId: string,
    input: UpdateCredentialBody,
  ): Promise<CredentialView> {
    const repository = new CredentialRepository(this.db, context.tenant.id);
    const existing = await this.requireExisting(context, credentialId);

    if (input.name !== undefined && input.name !== existing.name) {
      if ((await repository.findByName(input.name)) !== undefined) {
        throw new ValidationError('Credential name already exists');
      }
    }

    const updated = await repository.update(
      credentialId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: parseEpochOrNull(input.expiresAt) ?? null }),
        ...(input.secret === undefined
          ? {}
          : {
              secret: this.deps.cipher.encrypt(
                context.tenant.id,
                credentialId,
                existing.type,
                input.secret,
              ),
            }),
      },
      this.deps.now(),
    );

    if (updated === undefined) {
      throw new ValidationError('Credential was not updated');
    }

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.CREDENTIAL_UPDATE,
      AUDIT_RESOURCE_TYPE.CREDENTIAL,
      updated.id,
      {
        name: updated.name,
        type: updated.type,
        rotated: input.secret !== undefined,
      },
    );

    return this.view(context, updated);
  }

  async remove(context: AuthContext, credentialId: string): Promise<void> {
    const repository = new CredentialRepository(this.db, context.tenant.id);
    const credential = await this.requireExisting(context, credentialId);
    const projectReferences = await new ProjectRepository(
      this.db,
      context.tenant.id,
    ).countByCredential(credentialId);
    const llmReferences = await new LlmProfileRepository(
      this.db,
      context.tenant.id,
    ).countByCredential(credentialId);
    const environmentReferences = await new EnvironmentRepository(
      this.db,
      context.tenant.id,
    ).countByCredential(credentialId);

    if (projectReferences + llmReferences + environmentReferences > 0) {
      throw configError(
        'CREDENTIAL_IN_USE',
        'Credential is still referenced by project or configuration records',
        409,
      );
    }

    await repository.remove(credentialId);
    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.CREDENTIAL_DELETE,
      AUDIT_RESOURCE_TYPE.CREDENTIAL,
      credential.id,
      { name: credential.name, type: credential.type },
    );
  }

  async test(
    context: AuthContext,
    credentialId: string,
    repoUrlInput?: string,
  ): Promise<CredentialTestResult> {
    const credential = await this.requireExisting(context, credentialId);

    if (credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
      throw new ValidationError('Only Git credentials support connection tests');
    }

    let repoUrl = repoUrlInput;

    if (repoUrl === undefined) {
      const projects = await new ProjectRepository(this.db, context.tenant.id).list();
      const project = projects.find((item) => item.gitCredentialId === credentialId);
      repoUrl = project?.productRepoUrl;
    }

    if (repoUrl === undefined) {
      throw new ValidationError(
        'repoUrl is required when the credential is not referenced by a project',
      );
    }

    const result = await this.deps.gitLsRemote({
      repoUrl,
      ...(credential.username === null ? {} : { username: credential.username }),
      token: this.decryptSecret(context, credential),
    });

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.CREDENTIAL_TEST,
      AUDIT_RESOURCE_TYPE.CREDENTIAL,
      credential.id,
      { result: result.ok ? 'ok' : 'failed', code: result.code },
    );

    return {
      status: result.ok ? 'ok' : 'failed',
      code: result.code,
      message: result.message,
      durationMs: result.durationMs,
    };
  }
}
