// 本文件所有改动要求遵循 agent-rules 规范
import { NotFoundError, ValidationError } from '@gait/config';
import {
  CredentialRepository,
  EnvironmentGroupRepository,
  EnvironmentRepository,
  ProjectRepository,
} from '@gait/db';
import type { AppDatabase, Environment } from '@gait/db';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CREDENTIAL_TYPE,
  HEALTH_STATUS,
  isSensitiveEnvVarName,
} from '@gait/shared';
import type { DatabaseType, DatabaseWriteMode, HealthStatus, VersionSource } from '@gait/shared';
import type { CreateEnvironmentBody, UpdateEnvironmentBody } from '../api/config-schemas.js';
import type { AuthContext } from '../auth/auth-service.js';
import { HttpTimeoutError } from '../config/http-client.js';
import { jsonPathIssues, readVersionString } from '../config/json-path.js';
import { BlockedTargetError } from '../config/ssrf.js';
import type { ConfigServiceDeps } from './support.js';
import {
  configError,
  envVarsJsonFor,
  parseJsonObject,
  requireCredential,
  requireProject,
  writeConfigAudit,
} from './support.js';

interface ResolvedHealthcheck {
  url: string;
  expectedStatus: number;
  timeoutMs: number;
}

interface ResolvedVersion {
  source: VersionSource;
  endpoint: string | null;
  jsonPath: string | null;
  header: string | null;
  deployedSha: string | null;
  strictVersionMatch: boolean;
}

interface ResolvedDatabase {
  type: DatabaseType;
  host: string | null;
  port: number | null;
  name: string;
  schema: string | null;
  user: string | null;
  credentialId: string | null;
  ssl: boolean;
  isTest: boolean;
  writeMode: DatabaseWriteMode;
}

interface ResolvedEnvironment {
  groupId: string | null;
  name: string;
  apiBaseUrl: string;
  webBaseUrl: string | null;
  healthcheck: ResolvedHealthcheck | null;
  version: ResolvedVersion;
  testAccountCredentialId: string | null;
  resetEndpoint: string | null;
  setupScript: string | null;
  teardownScript: string | null;
  envVars: Record<string, string>;
  db: ResolvedDatabase | null;
  browser: Record<string, unknown>;
  caseTimeoutMs: number;
  apiConcurrency: number;
  uiConcurrency: number;
  isDefault: boolean;
}

export interface EnvironmentView {
  id: string;
  projectId: string;
  groupId: string | null;
  name: string;
  apiBaseUrl: string;
  webBaseUrl: string | null;
  healthcheck: ResolvedHealthcheck | null;
  version: ResolvedVersion;
  testAccountCredentialId: string | null;
  resetEndpoint: string | null;
  setupScript: string | null;
  teardownScript: string | null;
  envVars: Record<string, string>;
  db: ResolvedDatabase | null;
  browser: Record<string, unknown>;
  caseTimeoutMs: number;
  apiConcurrency: number;
  uiConcurrency: number;
  healthStatus: HealthStatus;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentCheckStep {
  status: 'ok' | 'failed' | 'skipped' | 'manual';
  code: string;
  message: string;
  durationMs: number;
}

export interface VersionCheckStep {
  status: 'ok' | 'failed' | 'skipped' | 'manual';
  sha: string | null;
  code: string;
  message: string;
}

export interface EnvironmentTestResult {
  status: 'ok' | 'failed';
  checkedAt: string;
  healthcheck: EnvironmentCheckStep | null;
  version: VersionCheckStep | null;
  deployedSha: string | null;
}

type FetchOutcome =
  | { ok: true; response: Awaited<ReturnType<ConfigServiceDeps['httpClient']>> }
  | { ok: false; code: string; message: string; durationMs: number };

function envVarsFrom(json: string): Record<string, string> {
  const parsed = parseJsonObject(json);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }

  return result;
}

function browserFrom(json: string): Record<string, unknown> {
  return parseJsonObject(json);
}

function healthcheckFrom(env: Environment): ResolvedHealthcheck | null {
  return env.healthcheckUrl === null
    ? null
    : {
        url: env.healthcheckUrl,
        expectedStatus: env.healthcheckExpectedStatus,
        timeoutMs: env.healthcheckTimeoutMs,
      };
}

function versionFrom(env: Environment): ResolvedVersion {
  return {
    source: env.versionSource,
    endpoint: env.versionEndpoint,
    jsonPath: env.versionJsonPath,
    header: env.versionHeader,
    deployedSha: env.deployedSha,
    strictVersionMatch: env.strictVersionMatch,
  };
}

function databaseFrom(env: Environment): ResolvedDatabase | null {
  if (env.dbType === null) {
    return null;
  }

  return {
    type: env.dbType,
    host: env.dbHost,
    port: env.dbPort,
    name: env.dbName ?? '',
    schema: env.dbSchema,
    user: env.dbUser,
    credentialId: env.dbCredentialId,
    ssl: env.dbSsl,
    isTest: env.dbIsTest,
    writeMode: env.dbWriteMode,
  };
}

function resolvedFrom(env: Environment): ResolvedEnvironment {
  return {
    groupId: env.groupId,
    name: env.name,
    apiBaseUrl: env.apiBaseUrl,
    webBaseUrl: env.webBaseUrl,
    healthcheck: healthcheckFrom(env),
    version: versionFrom(env),
    testAccountCredentialId: env.testAccountCredentialId,
    resetEndpoint: env.resetEndpoint,
    setupScript: env.setupScript,
    teardownScript: env.teardownScript,
    envVars: envVarsFrom(env.envVarsJson),
    db: databaseFrom(env),
    browser: browserFrom(env.browserJson),
    caseTimeoutMs: env.caseTimeoutMs,
    apiConcurrency: env.apiConcurrency,
    uiConcurrency: env.uiConcurrency,
    isDefault: env.isDefault,
  };
}

function resolvedFromCreate(input: CreateEnvironmentBody): ResolvedEnvironment {
  return {
    groupId: input.groupId ?? null,
    name: input.name,
    apiBaseUrl: input.apiBaseUrl,
    webBaseUrl: input.webBaseUrl ?? null,
    healthcheck:
      input.healthcheck === undefined || input.healthcheck === null
        ? null
        : {
            url: input.healthcheck.url,
            expectedStatus: input.healthcheck.expectedStatus,
            timeoutMs: input.healthcheck.timeoutMs,
          },
    version: {
      source: input.version.source,
      endpoint: input.version.endpoint ?? null,
      jsonPath: input.version.jsonPath ?? null,
      header: input.version.header ?? null,
      deployedSha: input.version.deployedSha ?? null,
      strictVersionMatch: input.version.strictVersionMatch,
    },
    testAccountCredentialId: input.testAccountCredentialId ?? null,
    resetEndpoint: input.resetEndpoint ?? null,
    setupScript: input.setupScript ?? null,
    teardownScript: input.teardownScript ?? null,
    envVars: input.envVars,
    db:
      input.db === undefined || input.db === null
        ? null
        : {
            type: input.db.type,
            host: input.db.host ?? null,
            port: input.db.port ?? null,
            name: input.db.name,
            schema: input.db.schema ?? null,
            user: input.db.user ?? null,
            credentialId: input.db.credentialId ?? null,
            ssl: input.db.ssl,
            isTest: input.db.isTest,
            writeMode: input.db.writeMode,
          },
    browser: input.browser,
    caseTimeoutMs: input.caseTimeoutMs,
    apiConcurrency: input.apiConcurrency,
    uiConcurrency: input.uiConcurrency,
    isDefault: input.isDefault,
  };
}

function applyUpdate(base: ResolvedEnvironment, input: UpdateEnvironmentBody): ResolvedEnvironment {
  const healthcheck =
    input.healthcheck === undefined
      ? base.healthcheck
      : input.healthcheck === null
        ? null
        : {
            url: input.healthcheck.url,
            expectedStatus: input.healthcheck.expectedStatus,
            timeoutMs: input.healthcheck.timeoutMs,
          };
  const versionInput = input.version;

  return {
    groupId: input.groupId === undefined ? base.groupId : input.groupId,
    name: input.name ?? base.name,
    apiBaseUrl: input.apiBaseUrl ?? base.apiBaseUrl,
    webBaseUrl: input.webBaseUrl === undefined ? base.webBaseUrl : input.webBaseUrl,
    healthcheck,
    version: {
      source: versionInput?.source ?? base.version.source,
      endpoint:
        versionInput?.endpoint === undefined ? base.version.endpoint : versionInput.endpoint,
      jsonPath:
        versionInput?.jsonPath === undefined ? base.version.jsonPath : versionInput.jsonPath,
      header: versionInput?.header === undefined ? base.version.header : versionInput.header,
      deployedSha:
        versionInput?.deployedSha === undefined
          ? base.version.deployedSha
          : versionInput.deployedSha,
      strictVersionMatch:
        versionInput?.strictVersionMatch === undefined
          ? base.version.strictVersionMatch
          : versionInput.strictVersionMatch,
    },
    testAccountCredentialId:
      input.testAccountCredentialId === undefined
        ? base.testAccountCredentialId
        : input.testAccountCredentialId,
    resetEndpoint: input.resetEndpoint === undefined ? base.resetEndpoint : input.resetEndpoint,
    setupScript: input.setupScript === undefined ? base.setupScript : input.setupScript,
    teardownScript: input.teardownScript === undefined ? base.teardownScript : input.teardownScript,
    envVars: input.envVars ?? base.envVars,
    db:
      input.db === undefined
        ? base.db
        : input.db === null
          ? null
          : {
              type: input.db.type,
              host: input.db.host ?? null,
              port: input.db.port ?? null,
              name: input.db.name,
              schema: input.db.schema ?? null,
              user: input.db.user ?? null,
              credentialId: input.db.credentialId ?? null,
              ssl: input.db.ssl,
              isTest: input.db.isTest,
              writeMode: input.db.writeMode,
            },
    browser: input.browser ?? base.browser,
    caseTimeoutMs: input.caseTimeoutMs ?? base.caseTimeoutMs,
    apiConcurrency: input.apiConcurrency ?? base.apiConcurrency,
    uiConcurrency: input.uiConcurrency ?? base.uiConcurrency,
    isDefault: input.isDefault ?? base.isDefault,
  };
}

function environmentView(env: Environment): EnvironmentView {
  return {
    id: env.id,
    projectId: env.projectId,
    ...resolvedFrom(env),
    healthStatus: env.healthStatus,
    healthCheckedAt:
      env.healthCheckedAt === null ? null : new Date(env.healthCheckedAt).toISOString(),
    healthMessage: env.healthMessage,
    createdAt: new Date(env.createdAt).toISOString(),
    updatedAt: new Date(env.updatedAt).toISOString(),
  };
}

export class EnvironmentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly deps: ConfigServiceDeps,
  ) {}

  async listGroups(
    context: AuthContext,
    projectId: string,
  ): Promise<Array<{ id: string; projectId: string; name: string; description: string }>> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const groups = await new EnvironmentGroupRepository(this.db, context.tenant.id).listByProject(
      projectId,
    );

    return groups.map((group) => ({
      id: group.id,
      projectId: group.projectId,
      name: group.name,
      description: group.description,
    }));
  }

  async createGroup(
    context: AuthContext,
    projectId: string,
    input: { name: string; description?: string | undefined },
  ): Promise<{ id: string; projectId: string; name: string; description: string }> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const group = await new EnvironmentGroupRepository(this.db, context.tenant.id).create({
      projectId,
      name: input.name,
      description: input.description ?? '',
      now: this.deps.now(),
    });

    return {
      id: group.id,
      projectId: group.projectId,
      name: group.name,
      description: group.description,
    };
  }

  async deleteGroup(context: AuthContext, projectId: string, groupId: string): Promise<void> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const group = await new EnvironmentGroupRepository(this.db, context.tenant.id).findById(
      groupId,
    );

    if (group === undefined || group.projectId !== projectId) {
      throw new NotFoundError('Environment group not found');
    }

    await new EnvironmentGroupRepository(this.db, context.tenant.id).remove(groupId);
  }

  private async requireEnvironment(
    context: AuthContext,
    environmentId: string,
  ): Promise<Environment> {
    const environment = await new EnvironmentRepository(this.db, context.tenant.id).findById(
      environmentId,
    );

    if (environment === undefined) {
      throw new NotFoundError('Environment not found');
    }

    return environment;
  }

  private async validateGroup(
    context: AuthContext,
    projectId: string,
    groupId: string | null,
  ): Promise<void> {
    if (groupId === null) {
      return;
    }

    const group = await new EnvironmentGroupRepository(this.db, context.tenant.id).findById(
      groupId,
    );

    if (group === undefined || group.projectId !== projectId) {
      throw new ValidationError('Environment group does not belong to this project');
    }
  }

  private async validateCredentialReference(
    context: AuthContext,
    credentialId: string | null,
    expectedType: typeof CREDENTIAL_TYPE.TEST_ACCOUNT | typeof CREDENTIAL_TYPE.DB_PASSWORD,
  ): Promise<void> {
    if (credentialId === null) {
      return;
    }

    requireCredential(
      await new CredentialRepository(this.db, context.tenant.id).findById(credentialId),
      expectedType,
    );
  }

  private async validateResolved(
    context: AuthContext,
    environment: ResolvedEnvironment,
    confirmDangerous: boolean | undefined,
    requireConfirmation: boolean,
  ): Promise<void> {
    const urls = [
      environment.apiBaseUrl,
      environment.webBaseUrl,
      environment.healthcheck?.url ?? null,
      environment.version.endpoint,
      environment.resetEndpoint,
    ];

    for (const url of urls) {
      if (url !== null) {
        this.deps.urlSafety.assertHttpUrl(url);
      }
    }

    if (environment.version.source === 'endpoint') {
      if (environment.version.endpoint === null || environment.version.jsonPath === null) {
        throw new ValidationError('Version endpoint and JSON path are required');
      }
    }

    if (environment.version.source === 'header' && environment.version.header === null) {
      throw new ValidationError('Version header is required');
    }

    if (
      environment.version.jsonPath !== null &&
      jsonPathIssues(environment.version.jsonPath).length > 0
    ) {
      throw new ValidationError('Version JSON path is invalid');
    }

    for (const name of Object.keys(environment.envVars)) {
      if (isSensitiveEnvVarName(name)) {
        throw configError(
          'SENSITIVE_ENV_VAR_FORBIDDEN',
          `Environment variable "${name}" looks sensitive; use a credential reference instead`,
        );
      }
    }

    await this.validateCredentialReference(
      context,
      environment.testAccountCredentialId,
      CREDENTIAL_TYPE.TEST_ACCOUNT,
    );

    if (environment.db !== null) {
      if (!environment.db.isTest) {
        throw configError(
          'PRODUCTION_DATABASE_FORBIDDEN',
          'Production database connections are not allowed; isTest must be true',
        );
      }

      if (
        environment.db.writeMode !== 'readonly' &&
        requireConfirmation &&
        confirmDangerous !== true
      ) {
        throw configError(
          'DANGEROUS_OPERATION_CONFIRMATION_REQUIRED',
          'Enabling database write mode requires confirmDangerous=true',
        );
      }

      await this.validateCredentialReference(
        context,
        environment.db.credentialId,
        CREDENTIAL_TYPE.DB_PASSWORD,
      );
    }
  }

  async create(
    context: AuthContext,
    projectId: string,
    input: CreateEnvironmentBody,
  ): Promise<EnvironmentView> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const repository = new EnvironmentRepository(this.db, context.tenant.id);
    const resolved = resolvedFromCreate(input);

    if ((await repository.findByName(projectId, input.name)) !== undefined) {
      throw new ValidationError('Environment name already exists');
    }

    await this.validateGroup(context, projectId, resolved.groupId);
    await this.validateResolved(context, resolved, input.confirmDangerous, true);
    const now = this.deps.now();

    if (resolved.isDefault) {
      await repository.clearDefault(projectId, undefined, now);
    }

    const environment = await repository.create({
      projectId,
      groupId: resolved.groupId,
      name: resolved.name,
      apiBaseUrl: resolved.apiBaseUrl,
      webBaseUrl: resolved.webBaseUrl,
      healthcheckUrl: resolved.healthcheck?.url ?? null,
      healthcheckExpectedStatus: resolved.healthcheck?.expectedStatus ?? 200,
      healthcheckTimeoutMs: resolved.healthcheck?.timeoutMs ?? 5_000,
      versionSource: resolved.version.source,
      versionEndpoint: resolved.version.endpoint,
      versionJsonPath: resolved.version.jsonPath,
      versionHeader: resolved.version.header,
      deployedSha: resolved.version.deployedSha,
      strictVersionMatch: resolved.version.strictVersionMatch,
      testAccountCredentialId: resolved.testAccountCredentialId,
      resetEndpoint: resolved.resetEndpoint,
      setupScript: resolved.setupScript,
      teardownScript: resolved.teardownScript,
      envVarsJson: envVarsJsonFor(resolved.envVars),
      db: resolved.db,
      browserJson: JSON.stringify(resolved.browser),
      caseTimeoutMs: resolved.caseTimeoutMs,
      apiConcurrency: resolved.apiConcurrency,
      uiConcurrency: resolved.uiConcurrency,
      isDefault: resolved.isDefault,
      now,
    });

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.ENVIRONMENT_CREATE,
      AUDIT_RESOURCE_TYPE.ENVIRONMENT,
      environment.id,
      {
        name: environment.name,
        versionSource: environment.versionSource,
        dbIsTest: environment.dbIsTest,
        dbWriteMode: environment.dbWriteMode,
      },
    );

    return environmentView(environment);
  }

  async list(context: AuthContext, projectId: string): Promise<EnvironmentView[]> {
    await requireProject(new ProjectRepository(this.db, context.tenant.id), projectId);
    const environments = await new EnvironmentRepository(this.db, context.tenant.id).listByProject(
      projectId,
    );

    return environments.map(environmentView);
  }

  async update(
    context: AuthContext,
    environmentId: string,
    input: UpdateEnvironmentBody,
  ): Promise<EnvironmentView> {
    const repository = new EnvironmentRepository(this.db, context.tenant.id);
    const existing = await this.requireEnvironment(context, environmentId);
    const resolved = applyUpdate(resolvedFrom(existing), input);

    if (input.name !== undefined && input.name !== existing.name) {
      if ((await repository.findByName(existing.projectId, input.name)) !== undefined) {
        throw new ValidationError('Environment name already exists');
      }
    }

    await this.validateGroup(context, existing.projectId, resolved.groupId);
    await this.validateResolved(context, resolved, input.confirmDangerous, input.db !== undefined);
    const now = this.deps.now();

    if (resolved.isDefault) {
      await repository.clearDefault(existing.projectId, environmentId, now);
    }

    const updated = await repository.update(
      environmentId,
      {
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
        ...(input.webBaseUrl === undefined ? {} : { webBaseUrl: input.webBaseUrl }),
        ...(input.healthcheck === undefined
          ? {}
          : input.healthcheck === null
            ? { healthcheckUrl: null }
            : {
                healthcheckUrl: input.healthcheck.url,
                healthcheckExpectedStatus: input.healthcheck.expectedStatus,
                healthcheckTimeoutMs: input.healthcheck.timeoutMs,
              }),
        versionSource: resolved.version.source,
        versionEndpoint: resolved.version.endpoint,
        versionJsonPath: resolved.version.jsonPath,
        versionHeader: resolved.version.header,
        deployedSha: resolved.version.deployedSha,
        strictVersionMatch: resolved.version.strictVersionMatch,
        ...(input.testAccountCredentialId === undefined
          ? {}
          : { testAccountCredentialId: input.testAccountCredentialId }),
        ...(input.resetEndpoint === undefined ? {} : { resetEndpoint: input.resetEndpoint }),
        ...(input.setupScript === undefined ? {} : { setupScript: input.setupScript }),
        ...(input.teardownScript === undefined ? {} : { teardownScript: input.teardownScript }),
        ...(input.envVars === undefined ? {} : { envVarsJson: envVarsJsonFor(input.envVars) }),
        ...(input.db === undefined ? {} : { db: resolved.db }),
        ...(input.browser === undefined ? {} : { browserJson: JSON.stringify(input.browser) }),
        ...(input.caseTimeoutMs === undefined ? {} : { caseTimeoutMs: input.caseTimeoutMs }),
        ...(input.apiConcurrency === undefined ? {} : { apiConcurrency: input.apiConcurrency }),
        ...(input.uiConcurrency === undefined ? {} : { uiConcurrency: input.uiConcurrency }),
        ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
      },
      now,
    );

    if (updated === undefined) {
      throw new ValidationError('Environment was not updated');
    }

    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.ENVIRONMENT_UPDATE,
      AUDIT_RESOURCE_TYPE.ENVIRONMENT,
      updated.id,
      { name: updated.name, fields: Object.keys(input) },
    );

    return environmentView(updated);
  }

  async remove(context: AuthContext, environmentId: string): Promise<void> {
    const repository = new EnvironmentRepository(this.db, context.tenant.id);
    const environment = await this.requireEnvironment(context, environmentId);

    await repository.remove(environmentId);
    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.ENVIRONMENT_DELETE,
      AUDIT_RESOURCE_TYPE.ENVIRONMENT,
      environment.id,
      { name: environment.name },
    );
  }

  private async request(url: string, timeoutMs: number): Promise<FetchOutcome> {
    let target: URL;

    try {
      target = await this.deps.urlSafety.assertRequestTarget(url);
    } catch (error) {
      if (error instanceof BlockedTargetError) {
        throw error;
      }

      return {
        ok: false,
        code: 'DNS_FAILURE',
        message: error instanceof Error ? error.message : 'DNS resolution failed',
        durationMs: 0,
      };
    }

    const startedAt = Date.now();

    try {
      const response = await this.deps.httpClient({
        method: 'GET',
        url: target.toString(),
        headers: { accept: 'application/json, text/plain, */*' },
        timeoutMs,
      });

      return { ok: true, response };
    } catch (error) {
      if (error instanceof HttpTimeoutError) {
        return {
          ok: false,
          code: 'TIMEOUT',
          message: 'Environment request timed out',
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        ok: false,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Environment request failed',
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async test(context: AuthContext, environmentId: string): Promise<EnvironmentTestResult> {
    const environment = await this.requireEnvironment(context, environmentId);
    const resolved = resolvedFrom(environment);
    const checkedAt = this.deps.now();
    let healthcheck: EnvironmentCheckStep | null;
    let healthResponse: Awaited<ReturnType<ConfigServiceDeps['httpClient']>> | undefined;
    let version: VersionCheckStep | null = null;
    let deployedSha = resolved.version.deployedSha;

    if (resolved.healthcheck === null) {
      healthcheck = {
        status: 'skipped',
        code: 'NO_HEALTHCHECK',
        message: 'Environment has no healthcheck URL',
        durationMs: 0,
      };
    } else {
      const startedAt = Date.now();
      const outcome = await this.request(resolved.healthcheck.url, resolved.healthcheck.timeoutMs);

      if (!outcome.ok) {
        healthcheck = {
          status: 'failed',
          code: outcome.code,
          message: outcome.message,
          durationMs: outcome.durationMs,
        };
      } else if (outcome.response.status !== resolved.healthcheck.expectedStatus) {
        healthcheck = {
          status: 'failed',
          code: 'HEALTHCHECK_STATUS_MISMATCH',
          message: `Expected HTTP ${resolved.healthcheck.expectedStatus}, got ${outcome.response.status}`,
          durationMs: Date.now() - startedAt,
        };
      } else {
        healthResponse = outcome.response;
        healthcheck = {
          status: 'ok',
          code: 'OK',
          message: `HTTP ${outcome.response.status}`,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    if (healthcheck.status === 'failed') {
      version = {
        status: 'skipped',
        sha: deployedSha,
        code: 'HEALTHCHECK_FAILED',
        message: 'Version check skipped because the healthcheck failed',
      };
    } else if (resolved.version.source === 'manual') {
      version = {
        status: 'manual',
        sha: deployedSha,
        code: 'MANUAL',
        message: 'Deployed version is maintained manually',
      };
    } else if (resolved.version.source === 'header') {
      const headerName = (resolved.version.header ?? '').toLowerCase();
      let response = healthResponse;

      if (response === undefined) {
        const outcome = await this.request(
          resolved.apiBaseUrl,
          resolved.healthcheck?.timeoutMs ?? 5_000,
        );

        if (!outcome.ok) {
          version = {
            status: 'failed',
            sha: null,
            code: outcome.code,
            message: outcome.message,
          };
        } else {
          response = outcome.response;
        }
      }

      if (response !== undefined) {
        const headerValue = response.headers[headerName]?.trim() ?? '';
        const sha = headerValue.length > 0 && headerValue.length <= 255 ? headerValue : null;

        version =
          sha === null
            ? {
                status: 'failed',
                sha: null,
                code: 'VERSION_NOT_FOUND',
                message: `Response header "${headerName}" is missing or invalid`,
              }
            : { status: 'ok', sha, code: 'OK', message: `Resolved from header ${headerName}` };
      }
    } else {
      const endpoint = resolved.version.endpoint;

      if (endpoint === null || resolved.version.jsonPath === null) {
        version = {
          status: 'failed',
          sha: null,
          code: 'VERSION_NOT_CONFIGURED',
          message: 'Version endpoint or JSON path is missing',
        };
      } else {
        const outcome = await this.request(endpoint, resolved.healthcheck?.timeoutMs ?? 5_000);

        if (!outcome.ok) {
          version = {
            status: 'failed',
            sha: null,
            code: outcome.code,
            message: outcome.message,
          };
        } else if (outcome.response.status < 200 || outcome.response.status >= 300) {
          version = {
            status: 'failed',
            sha: null,
            code: 'VERSION_HTTP_ERROR',
            message: `Version endpoint returned HTTP ${outcome.response.status}`,
          };
        } else {
          let json: unknown;

          try {
            json = JSON.parse(outcome.response.bodyText);
          } catch {
            json = undefined;
          }

          const sha =
            json === undefined ? null : readVersionString(json, resolved.version.jsonPath);

          version =
            sha === null
              ? {
                  status: 'failed',
                  sha: null,
                  code: 'VERSION_NOT_FOUND',
                  message: 'Version JSON path did not resolve to a string',
                }
              : {
                  status: 'ok',
                  sha,
                  code: 'OK',
                  message: `Resolved from ${resolved.version.jsonPath}`,
                };
        }
      }
    }

    if (version === null) {
      version = {
        status: 'failed',
        sha: null,
        code: 'VERSION_CHECK_FAILED',
        message: 'Version check did not complete',
      };
    }

    if (version.status === 'ok' || version.status === 'manual') {
      deployedSha = version.sha;
    }

    const healthStatus =
      healthcheck.status === 'ok'
        ? HEALTH_STATUS.HEALTHY
        : healthcheck.status === 'failed'
          ? HEALTH_STATUS.UNHEALTHY
          : version.status === 'ok'
            ? HEALTH_STATUS.HEALTHY
            : version.status === 'failed'
              ? HEALTH_STATUS.UNHEALTHY
              : HEALTH_STATUS.UNKNOWN;
    const healthMessage = healthcheck.status === 'skipped' ? version.message : healthcheck.message;
    const overallStatus =
      healthcheck.status === 'failed' || version.status === 'failed' ? 'failed' : 'ok';

    await new EnvironmentRepository(this.db, context.tenant.id).update(
      environmentId,
      {
        healthStatus,
        healthCheckedAt: checkedAt,
        healthMessage,
        deployedSha,
      },
      checkedAt,
    );
    await writeConfigAudit(
      this.deps,
      context,
      AUDIT_ACTION.ENVIRONMENT_TEST,
      AUDIT_RESOURCE_TYPE.ENVIRONMENT,
      environmentId,
      {
        result: overallStatus,
        healthcheck: healthcheck.status,
        version: version.status,
      },
    );

    return {
      status: overallStatus,
      checkedAt: new Date(checkedAt).toISOString(),
      healthcheck,
      version,
      deployedSha,
    };
  }
}
