// 本文件所有改动要求遵循 agent-rules 规范
import { NotFoundError, ValidationError } from '@gait/config';
import { CredentialRepository, LlmProfileRepository, ProjectRepository } from '@gait/db';
import type { AppDatabase, LlmProfile } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE, HEALTH_STATUS } from '@gait/shared';
import type { HealthStatus, LlmProvider, LlmPurpose } from '@gait/shared';
import type { CreateLlmProfileBody, UpdateLlmProfileBody } from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
import { HttpTimeoutError, joinUrl } from '../config/http-client.js';
import { DnsResolutionError } from '../config/ssrf.js';
import type { ConfigServiceDeps } from './support.js';
import { parseJsonObject, requireCredential, requireProject, writeConfigAudit } from './support.js';

export interface LlmProfileView {
  id: string;
  projectId: string;
  name: string;
  purpose: LlmPurpose;
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  credentialId: string | null;
  credentialName: string | null;
  params: Record<string, unknown>;
  enabled: boolean;
  healthStatus: HealthStatus;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmTestResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  checkedAt: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function providerModelsUrl(provider: LlmProvider, baseUrl: string): string {
  if (provider === 'anthropic') {
    return baseUrl.replace(/\/+$/, '').endsWith('/v1')
      ? joinUrl(baseUrl, 'models')
      : joinUrl(baseUrl, 'v1/models');
  }

  if (provider === 'gemini') {
    return baseUrl.replace(/\/+$/, '').endsWith('/v1beta')
      ? joinUrl(baseUrl, 'models')
      : joinUrl(baseUrl, 'v1beta/models');
  }

  return joinUrl(baseUrl, 'models');
}

function sanitizeMessage(message: string, secret?: string): string {
  let value = message;

  if (secret !== undefined && secret.length > 0) {
    value = value.split(secret).join('****');
  }

  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

export class LlmProfileService {
  constructor(
    private readonly db: AppDatabase,
    private readonly deps: ConfigServiceDeps,
  ) {}

  private credentialName(context: AuthContext, credentialId: string | null): string | null {
    if (credentialId === null) {
      return null;
    }

    return (
      new CredentialRepository(this.db, context.tenant.id).findById(credentialId)?.name ?? null
    );
  }

  private view(context: AuthContext, profile: LlmProfile): LlmProfileView {
    return {
      id: profile.id,
      projectId: profile.projectId,
      name: profile.name,
      purpose: profile.purpose,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      credentialId: profile.credentialId,
      credentialName: this.credentialName(context, profile.credentialId),
      params: parseJsonObject(profile.paramsJson),
      enabled: profile.enabled,
      healthStatus: profile.healthStatus,
      healthCheckedAt:
        profile.healthCheckedAt === null ? null : new Date(profile.healthCheckedAt).toISOString(),
      healthMessage: profile.healthMessage,
      createdAt: new Date(profile.createdAt).toISOString(),
      updatedAt: new Date(profile.updatedAt).toISOString(),
    };
  }

  private validateCredential(context: AuthContext, credentialId: string | null): void {
    if (credentialId === null) {
      return;
    }

    requireCredential(
      new CredentialRepository(this.db, context.tenant.id).findById(credentialId),
      CREDENTIAL_TYPE.LLM_API_KEY,
    );
  }

  create(context: AuthContext, projectId: string, input: CreateLlmProfileBody): LlmProfileView {
    requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    this.deps.urlSafety.assertHttpUrl(input.baseUrl);
    const repository = new LlmProfileRepository(this.db, context.tenant.id);

    if (repository.findByName(projectId, input.name) !== undefined) {
      throw new ValidationError('LLM profile name already exists');
    }

    const credentialId = input.credentialId ?? null;
    this.validateCredential(context, credentialId);

    const profile = repository.create({
      projectId,
      name: input.name,
      purpose: input.purpose,
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      credentialId,
      paramsJson: JSON.stringify(input.params),
      enabled: input.enabled,
      now: this.deps.now(),
    });

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.LLM_PROFILE_CREATE,
      AUDIT_RESOURCE_TYPE.LLM_PROFILE,
      profile.id,
      { name: profile.name, purpose: profile.purpose, provider: profile.provider },
    );

    return this.view(context, profile);
  }

  list(context: AuthContext, projectId: string): LlmProfileView[] {
    requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);

    return new LlmProfileRepository(this.db, context.tenant.id)
      .listByProject(projectId)
      .map((profile) => this.view(context, profile));
  }

  update(context: AuthContext, profileId: string, input: UpdateLlmProfileBody): LlmProfileView {
    const repository = new LlmProfileRepository(this.db, context.tenant.id);
    const existing = repository.findById(profileId);

    if (existing === undefined) {
      throw new NotFoundError('LLM profile not found');
    }

    if (input.baseUrl !== undefined) {
      this.deps.urlSafety.assertHttpUrl(input.baseUrl);
    }

    if (input.name !== undefined && input.name !== existing.name) {
      if (repository.findByName(existing.projectId, input.name) !== undefined) {
        throw new ValidationError('LLM profile name already exists');
      }
    }

    const credentialId =
      input.credentialId === undefined ? existing.credentialId : input.credentialId;

    if (input.credentialId !== undefined) {
      this.validateCredential(context, credentialId);
    }

    const connectionChanged =
      (input.provider !== undefined && input.provider !== existing.provider) ||
      (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) ||
      (input.model !== undefined && input.model !== existing.model) ||
      (input.credentialId !== undefined && input.credentialId !== existing.credentialId);

    const updated = repository.update(
      profileId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }),
        ...(input.params === undefined ? {} : { paramsJson: JSON.stringify(input.params) }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(connectionChanged
          ? {
              healthStatus: HEALTH_STATUS.UNKNOWN,
              healthCheckedAt: null,
              healthMessage: null,
            }
          : {}),
      },
      this.deps.now(),
    );

    if (updated === undefined) {
      throw new ValidationError('LLM profile was not updated');
    }

    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.LLM_PROFILE_UPDATE,
      AUDIT_RESOURCE_TYPE.LLM_PROFILE,
      updated.id,
      {
        name: updated.name,
        purpose: updated.purpose,
        provider: updated.provider,
        fields: Object.keys(input),
      },
    );

    return this.view(context, updated);
  }

  remove(context: AuthContext, profileId: string): void {
    const repository = new LlmProfileRepository(this.db, context.tenant.id);
    const profile = repository.findById(profileId);

    if (profile === undefined) {
      throw new NotFoundError('LLM profile not found');
    }

    repository.remove(profileId);
    writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.LLM_PROFILE_DELETE,
      AUDIT_RESOURCE_TYPE.LLM_PROFILE,
      profile.id,
      { name: profile.name, purpose: profile.purpose },
    );
  }

  async test(context: AuthContext, profileId: string): Promise<LlmTestResult> {
    const profile = new LlmProfileRepository(this.db, context.tenant.id).findById(profileId);

    if (profile === undefined) {
      throw new NotFoundError('LLM profile not found');
    }

    const params = parseJsonObject(profile.paramsJson);
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
    let secret: string | undefined;

    if (profile.credentialId !== null) {
      const credential = requireCredential(
        new CredentialRepository(this.db, context.tenant.id).findById(profile.credentialId),
        CREDENTIAL_TYPE.LLM_API_KEY,
      );
      secret = this.deps.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
        ciphertext: credential.secretCiphertext,
        iv: credential.secretIv,
        authTag: credential.secretAuthTag,
        keyVersion: credential.keyVersion,
      });
    }

    const target = providerModelsUrl(profile.provider, profile.baseUrl);
    const checkedAt = this.deps.now();
    const startedAt = Date.now();
    const finish = (status: 'ok' | 'failed', code: string, message: string): LlmTestResult => {
      const healthStatus = status === 'ok' ? HEALTH_STATUS.HEALTHY : HEALTH_STATUS.UNHEALTHY;

      new LlmProfileRepository(this.db, context.tenant.id).update(
        profileId,
        {
          healthStatus,
          healthCheckedAt: checkedAt,
          healthMessage: sanitizeMessage(message, secret),
        },
        checkedAt,
      );
      writeConfigAudit(
        this.deps,
        context,
        AUDIT_ACTION.LLM_PROFILE_TEST,
        AUDIT_RESOURCE_TYPE.LLM_PROFILE,
        profileId,
        { result: status, code },
      );

      return {
        status,
        code,
        message: sanitizeMessage(message, secret),
        checkedAt: new Date(checkedAt).toISOString(),
        durationMs: Date.now() - startedAt,
      };
    };

    try {
      await this.deps.urlSafety.assertRequestTarget(target);
    } catch (error) {
      if (error instanceof DnsResolutionError) {
        return finish('failed', 'DNS_FAILURE', error.message);
      }

      throw error;
    }

    const headers: Record<string, string> = { accept: 'application/json' };

    if (secret !== undefined) {
      if (profile.provider === 'anthropic') {
        headers['x-api-key'] = secret;
        headers['anthropic-version'] = '2023-06-01';
      } else if (profile.provider === 'gemini') {
        headers['x-goog-api-key'] = secret;
      } else {
        headers.authorization = `Bearer ${secret}`;
      }
    }

    try {
      const response = await this.deps.httpClient({
        method: 'GET',
        url: target,
        headers,
        timeoutMs,
      });

      if (response.status >= 200 && response.status < 300) {
        return finish('ok', 'OK', `HTTP ${response.status}`);
      }

      if (response.status === 401 || response.status === 403) {
        return finish('failed', 'AUTH_FAILED', `HTTP ${response.status}`);
      }

      return finish('failed', 'HTTP_ERROR', `HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof HttpTimeoutError) {
        return finish('failed', 'TIMEOUT', 'LLM request timed out');
      }

      return finish(
        'failed',
        'NETWORK_ERROR',
        error instanceof Error ? error.message : 'LLM request failed',
      );
    }
  }
}
