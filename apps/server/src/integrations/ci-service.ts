// 本文件所有改动要求遵循 agent-rules 规范
import { AppError, NotFoundError, ValidationError } from '@gait/config';
import type { SecretCipher } from '@gait/config';
import {
  CiIntegrationRepository,
  CredentialRepository,
  ProjectRepository,
  RunRepository,
} from '@gait/db';
import type { AppDatabase, AuditLogWriter, CiIntegration, CiProvider } from '@gait/db';
import { buildRunReport, renderReportMarkdown } from '@gait/agent';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE, CREDENTIAL_TYPE } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import type { ConfigServiceDeps } from '../projects/support.js';
import { requireProject } from '../projects/support.js';

export interface CiIntegrationView {
  id: string;
  projectId: string;
  name: string;
  provider: CiProvider;
  repository: string;
  apiBaseUrl: string | null;
  tokenCredentialId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CiTestResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  durationMs: number;
}

export interface PublishCiReportInput {
  /** 路径中的项目 ID，用于防止借用本项目路径操作其他项目的集成。 */
  projectId: string;
  integrationId: string;
  runId: string;
  pullRequestNumber: number;
}

export interface CiPublishResult {
  status: 'ok' | 'failed';
  code: string;
  message: string;
  responseStatus: number | null;
}

export interface CiServiceOptions {
  db: AppDatabase;
  deps: ConfigServiceDeps;
  cipher: SecretCipher;
  auditWriter: AuditLogWriter;
  publicBaseUrl: string;
}

function view(integration: CiIntegration): CiIntegrationView {
  return {
    id: integration.id,
    projectId: integration.projectId,
    name: integration.name,
    provider: integration.provider,
    repository: integration.repository,
    apiBaseUrl: integration.apiBaseUrl,
    tokenCredentialId: integration.tokenCredentialId,
    enabled: integration.enabled,
    createdAt: new Date(integration.createdAt).toISOString(),
    updatedAt: new Date(integration.updatedAt).toISOString(),
  };
}

function defaultBase(provider: CiProvider): string {
  return provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com/api/v4';
}

/**
 * CI/PR 集成：配置仓库与 token，测试连通性，并把 Run 报告回写为 PR/MR 评论。
 * 外部 CI 仍使用平台 Webhook/部署回调触发；本服务只负责报告回写。
 */
export class CiService {
  private readonly db: AppDatabase;
  private readonly deps: ConfigServiceDeps;
  private readonly cipher: SecretCipher;
  private readonly auditWriter: AuditLogWriter;
  private readonly publicBaseUrl: string;

  constructor(options: CiServiceOptions) {
    this.db = options.db;
    this.deps = options.deps;
    this.cipher = options.cipher;
    this.auditWriter = options.auditWriter;
    this.publicBaseUrl = options.publicBaseUrl;
  }

  async list(context: AuthContext, projectId: string): Promise<CiIntegrationView[]> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const integrations = await new CiIntegrationRepository(
      this.db,
      context.tenant.id,
    ).listByProject(projectId);

    return integrations.map(view);
  }

  async upsert(
    context: AuthContext,
    projectId: string,
    input: {
      name: string;
      provider: CiProvider;
      repository: string;
      apiBaseUrl?: string | undefined;
      tokenCredentialId?: string | null | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<CiIntegrationView> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);

    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(input.repository)) {
      throw new ValidationError('Repository must be owner/repo');
    }

    if (input.apiBaseUrl !== undefined) {
      this.deps.urlSafety.assertHttpUrl(input.apiBaseUrl);
    }

    if (input.tokenCredentialId !== undefined && input.tokenCredentialId !== null) {
      const credential = await new CredentialRepository(this.db, context.tenant.id).findById(
        input.tokenCredentialId,
      );

      if (credential === undefined || credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
        throw new ValidationError('CI token must use a git_pat credential');
      }
    }

    const integration = await new CiIntegrationRepository(this.db, context.tenant.id).upsert({
      projectId,
      name: input.name,
      provider: input.provider,
      repository: input.repository,
      apiBaseUrl: input.apiBaseUrl ?? null,
      tokenCredentialId: input.tokenCredentialId ?? null,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      now: this.deps.now(),
    });

    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.CI_INTEGRATION_UPSERT,
      resourceType: AUDIT_RESOURCE_TYPE.CI_INTEGRATION,
      resourceId: integration.id,
      detail: {
        projectId,
        provider: integration.provider,
        repository: integration.repository,
      },
      now: this.deps.now(),
    });

    return view(integration);
  }

  async remove(context: AuthContext, projectId: string, integrationId: string): Promise<void> {
    const repository = new CiIntegrationRepository(this.db, context.tenant.id);
    const integration = await this.requireIntegration(context, integrationId, projectId);

    await repository.remove(integration.id);
    await this.auditWriter.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.CI_INTEGRATION_DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CI_INTEGRATION,
      resourceId: integrationId,
      detail: { projectId: integration.projectId },
      now: this.deps.now(),
    });
  }

  async test(
    context: AuthContext,
    projectId: string,
    integrationId: string,
  ): Promise<CiTestResult> {
    const integration = await this.requireIntegration(context, integrationId, projectId);
    const startedAt = Date.now();

    try {
      const token = await this.tokenOf(context, integration);
      const url =
        integration.provider === 'github'
          ? `${this.baseOf(integration)}/repos/${integration.repository}`
          : `${this.baseOf(integration)}/projects/${encodeURIComponent(integration.repository)}`;
      const target = await this.deps.urlSafety.assertRequestTarget(url, { httpsOnly: true });
      const response = await this.deps.httpClient({
        method: 'GET',
        url: target.toString(),
        headers:
          integration.provider === 'github'
            ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
            : { 'private-token': token },
        timeoutMs: 10_000,
      });
      const ok = response.status >= 200 && response.status < 300;

      return {
        status: ok ? 'ok' : 'failed',
        code: ok ? 'OK' : 'CI_AUTH_OR_HTTP_ERROR',
        message: ok ? 'CI repository is reachable' : `CI API returned ${response.status}`,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'failed',
        code: 'CI_NETWORK_ERROR',
        message: error instanceof Error ? error.message.slice(0, 300) : String(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async publish(context: AuthContext, input: PublishCiReportInput): Promise<CiPublishResult> {
    const integration = await this.requireIntegration(
      context,
      input.integrationId,
      input.projectId,
    );
    const run = await new RunRepository(this.db, context.tenant.id).findById(input.runId);

    if (run === undefined || run.projectId !== integration.projectId) {
      throw new NotFoundError('Run not found');
    }

    const report = await buildRunReport({
      db: this.db,
      tenantId: context.tenant.id,
      runId: run.id,
      baseUrl: this.publicBaseUrl,
      now: this.deps.now,
    });
    const markdown = renderReportMarkdown(report).slice(0, 60_000);
    const token = await this.tokenOf(context, integration);
    const split = integration.repository.split('/');
    const last = split[split.length - 1] ?? integration.repository;
    const ownerPath = split.slice(0, -1).join('/');
    const url =
      integration.provider === 'github'
        ? `${this.baseOf(integration)}/repos/${integration.repository}/issues/${input.pullRequestNumber}/comments`
        : `${this.baseOf(integration)}/projects/${encodeURIComponent(integration.repository)}/merge_requests/${input.pullRequestNumber}/notes`;
    const body =
      integration.provider === 'github'
        ? JSON.stringify({ body: markdown })
        : JSON.stringify({ body: markdown });
    const target = await this.deps.urlSafety.assertRequestTarget(url, { httpsOnly: true });

    try {
      const response = await this.deps.httpClient({
        method: 'POST',
        url: target.toString(),
        headers:
          integration.provider === 'github'
            ? {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'content-type': 'application/json',
              }
            : {
                'private-token': token,
                'content-type': 'application/json',
              },
        body,
        timeoutMs: 15_000,
        maxResponseBytes: 4_096,
      });
      const ok = response.status >= 200 && response.status < 300;

      await this.auditWriter.append({
        tenantId: context.tenant.id,
        actorUserId: context.user.id,
        action: AUDIT_ACTION.CI_REPORT_PUBLISH,
        resourceType: AUDIT_RESOURCE_TYPE.CI_INTEGRATION,
        resourceId: integration.id,
        detail: {
          runId: run.id,
          provider: integration.provider,
          repository: integration.repository,
          owner: ownerPath,
          project: last,
          pullRequestNumber: input.pullRequestNumber,
          status: response.status,
        },
        now: this.deps.now(),
      });

      return {
        status: ok ? 'ok' : 'failed',
        code: ok ? 'OK' : 'CI_PUBLISH_FAILED',
        message: ok ? 'Report comment published' : `CI API returned ${response.status}`,
        responseStatus: response.status,
      };
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message.slice(0, 300) : String(error), {
        status: 502,
        code: 'CI_PUBLISH_FAILED',
      });
    }
  }

  private baseOf(integration: CiIntegration): string {
    return (integration.apiBaseUrl ?? defaultBase(integration.provider)).replace(/\/+$/, '');
  }

  private async requireIntegration(
    context: AuthContext,
    id: string,
    expectedProjectId: string,
  ): Promise<CiIntegration> {
    const integration = await new CiIntegrationRepository(this.db, context.tenant.id).findById(id);

    // 路径项目与集成所属项目不一致时按不存在处理，避免越权操作同租户其他项目。
    if (integration === undefined || integration.projectId !== expectedProjectId) {
      throw new NotFoundError('CI integration not found');
    }

    return integration;
  }

  private async tokenOf(context: AuthContext, integration: CiIntegration): Promise<string> {
    if (integration.tokenCredentialId === null) {
      throw new ValidationError('CI token is not configured');
    }

    const credential = await new CredentialRepository(this.db, context.tenant.id).findById(
      integration.tokenCredentialId,
    );

    if (credential === undefined || credential.type !== CREDENTIAL_TYPE.GIT_PAT) {
      throw new ValidationError('CI token credential is unavailable');
    }

    return this.cipher.decrypt(context.tenant.id, credential.id, credential.type, {
      ciphertext: credential.secretCiphertext,
      iv: credential.secretIv,
      authTag: credential.secretAuthTag,
      keyVersion: credential.keyVersion,
    });
  }
}
