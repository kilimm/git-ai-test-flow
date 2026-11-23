// 本文件所有改动要求遵循 agent-rules 规范
import { AppError, NotFoundError, ValidationError } from '@gait/config';
import type { AuditLogWriter, Credential, Project } from '@gait/db';
import type { ProjectRepository } from '@gait/db';
import type { AuditAction, AuditResourceType, CredentialType } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';
import type { GitLsRemote } from '../config/git-client.js';
import type { HttpClient } from '../config/http-client.js';
import type { SecretCipher } from '../config/secrets.js';
import type { UrlSafetyChecker } from '../config/ssrf.js';

export interface ConfigServiceDeps {
  auditWriter: AuditLogWriter;
  cipher: SecretCipher;
  urlSafety: UrlSafetyChecker;
  httpClient: HttpClient;
  gitLsRemote: GitLsRemote;
  now: () => number;
}

export function configError(code: string, detail: string, status = 400): AppError {
  return new AppError(detail, { status, code, detail });
}

export async function writeConfigAudit(
  deps: ConfigServiceDeps,
  context: AuthContext,
  action: AuditAction,
  resourceType: AuditResourceType,
  resourceId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.auditWriter.append({
    tenantId: context.tenant.id,
    actorUserId: context.user.id,
    action,
    resourceType,
    resourceId,
    detail,
    now: deps.now(),
  });
}

export async function requireProject(
  repository: ProjectRepository,
  projectId: string,
): Promise<Project> {
  const project = await repository.findById(projectId);

  if (project === undefined) {
    throw new NotFoundError('Project not found');
  }

  return project;
}

export function requireCredential(
  credential: Credential | undefined,
  expectedType?: CredentialType,
): Credential {
  if (credential === undefined) {
    throw new ValidationError('Credential not found');
  }

  if (expectedType !== undefined && credential.type !== expectedType) {
    throw new ValidationError(`Credential must be of type ${expectedType}`);
  }

  return credential;
}

export function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed: unknown = JSON.parse(json);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

export function settingsJsonFor(settings: Record<string, unknown>): string {
  const json = JSON.stringify(settings);

  if (json.length > 10_000) {
    throw new ValidationError('Project settings must be at most 10 KB');
  }

  return json;
}

export function envVarsJsonFor(envVars: Record<string, string>): string {
  const json = JSON.stringify(envVars);

  if (json.length > 20_000) {
    throw new ValidationError('Environment variables must be at most 20 KB');
  }

  return json;
}

export function browserJsonFor(browser: Record<string, unknown>): string {
  return JSON.stringify(browser);
}

export function parseEpochOrNull(value: string | null | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new ValidationError('Invalid date');
  }

  return parsed;
}
