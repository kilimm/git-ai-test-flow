// 本文件所有改动要求遵循 agent-rules 规范
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import { nowMs, uuidv7 } from '@gait/config';
import type { DatabaseType, DatabaseWriteMode, HealthStatus, VersionSource } from '@gait/shared';
import type { AppDatabase } from '../client.js';
import { TenantScopedRepository } from '../repository.js';
import { environments } from '../schema.js';
import type { Environment, NewEnvironment } from '../schema.js';

export interface EnvironmentDatabaseConfig {
  type: DatabaseType;
  host?: string | null;
  port?: number | null;
  name: string;
  schema?: string | null;
  user?: string | null;
  credentialId?: string | null;
  ssl: boolean;
  isTest: boolean;
  writeMode: DatabaseWriteMode;
}

export interface CreateEnvironmentInput {
  id?: string;
  projectId: string;
  groupId?: string | null;
  name: string;
  apiBaseUrl: string;
  webBaseUrl?: string | null;
  healthcheckUrl?: string | null;
  healthcheckExpectedStatus: number;
  healthcheckTimeoutMs: number;
  versionSource: VersionSource;
  versionEndpoint?: string | null;
  versionJsonPath?: string | null;
  versionHeader?: string | null;
  deployedSha?: string | null;
  strictVersionMatch: boolean;
  testAccountCredentialId?: string | null;
  resetEndpoint?: string | null;
  setupScript?: string | null;
  teardownScript?: string | null;
  envVarsJson: string;
  db?: EnvironmentDatabaseConfig | null;
  browserJson: string;
  caseTimeoutMs: number;
  apiConcurrency: number;
  uiConcurrency: number;
  isDefault: boolean;
  now?: number;
}

export interface UpdateEnvironmentInput {
  groupId?: string | null;
  name?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string | null;
  healthcheckUrl?: string | null;
  healthcheckExpectedStatus?: number;
  healthcheckTimeoutMs?: number;
  versionSource?: VersionSource;
  versionEndpoint?: string | null;
  versionJsonPath?: string | null;
  versionHeader?: string | null;
  deployedSha?: string | null;
  strictVersionMatch?: boolean;
  testAccountCredentialId?: string | null;
  resetEndpoint?: string | null;
  setupScript?: string | null;
  teardownScript?: string | null;
  envVarsJson?: string;
  db?: EnvironmentDatabaseConfig | null;
  browserJson?: string;
  caseTimeoutMs?: number;
  apiConcurrency?: number;
  uiConcurrency?: number;
  isDefault?: boolean;
  healthStatus?: HealthStatus;
  healthCheckedAt?: number | null;
  healthMessage?: string | null;
}

function databaseValues(db: EnvironmentDatabaseConfig): Partial<NewEnvironment> {
  return {
    dbType: db.type,
    dbHost: db.host ?? null,
    dbPort: db.port ?? null,
    dbName: db.name,
    dbSchema: db.schema ?? null,
    dbUser: db.user ?? null,
    dbCredentialId: db.credentialId ?? null,
    dbSsl: db.ssl,
    dbIsTest: db.isTest,
    dbWriteMode: db.writeMode,
  };
}

export class EnvironmentRepository extends TenantScopedRepository {
  constructor(db: AppDatabase, tenantId: string) {
    super(db, tenantId);
  }

  create(input: CreateEnvironmentInput): Environment {
    const now = input.now ?? nowMs();

    return this.db
      .insert(environments)
      .values({
        id: input.id ?? uuidv7(now),
        tenantId: this.tenantId,
        projectId: input.projectId,
        groupId: input.groupId ?? null,
        name: input.name,
        apiBaseUrl: input.apiBaseUrl,
        webBaseUrl: input.webBaseUrl ?? null,
        healthcheckUrl: input.healthcheckUrl ?? null,
        healthcheckExpectedStatus: input.healthcheckExpectedStatus,
        healthcheckTimeoutMs: input.healthcheckTimeoutMs,
        versionSource: input.versionSource,
        versionEndpoint: input.versionEndpoint ?? null,
        versionJsonPath: input.versionJsonPath ?? null,
        versionHeader: input.versionHeader ?? null,
        deployedSha: input.deployedSha ?? null,
        strictVersionMatch: input.strictVersionMatch,
        testAccountCredentialId: input.testAccountCredentialId ?? null,
        resetEndpoint: input.resetEndpoint ?? null,
        setupScript: input.setupScript ?? null,
        teardownScript: input.teardownScript ?? null,
        envVarsJson: input.envVarsJson,
        ...(input.db === undefined || input.db === null ? {} : databaseValues(input.db)),
        browserJson: input.browserJson,
        caseTimeoutMs: input.caseTimeoutMs,
        apiConcurrency: input.apiConcurrency,
        uiConcurrency: input.uiConcurrency,
        isDefault: input.isDefault,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  listByProject(projectId: string): Environment[] {
    return this.db
      .select()
      .from(environments)
      .where(and(eq(environments.tenantId, this.tenantId), eq(environments.projectId, projectId)))
      .orderBy(desc(environments.createdAt), desc(environments.id))
      .all();
  }

  findById(id: string): Environment | undefined {
    return this.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, id), eq(environments.tenantId, this.tenantId)))
      .get();
  }

  findByName(projectId: string, name: string): Environment | undefined {
    return this.db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.tenantId, this.tenantId),
          eq(environments.projectId, projectId),
          eq(environments.name, name),
        ),
      )
      .get();
  }

  update(
    id: string,
    input: UpdateEnvironmentInput,
    now: number = nowMs(),
  ): Environment | undefined {
    const values: Partial<NewEnvironment> = { updatedAt: now };

    if (input.groupId !== undefined) {
      values.groupId = input.groupId;
    }

    if (input.name !== undefined) {
      values.name = input.name;
    }

    if (input.apiBaseUrl !== undefined) {
      values.apiBaseUrl = input.apiBaseUrl;
    }

    if (input.webBaseUrl !== undefined) {
      values.webBaseUrl = input.webBaseUrl;
    }

    if (input.healthcheckUrl !== undefined) {
      values.healthcheckUrl = input.healthcheckUrl;
    }

    if (input.healthcheckExpectedStatus !== undefined) {
      values.healthcheckExpectedStatus = input.healthcheckExpectedStatus;
    }

    if (input.healthcheckTimeoutMs !== undefined) {
      values.healthcheckTimeoutMs = input.healthcheckTimeoutMs;
    }

    if (input.versionSource !== undefined) {
      values.versionSource = input.versionSource;
    }

    if (input.versionEndpoint !== undefined) {
      values.versionEndpoint = input.versionEndpoint;
    }

    if (input.versionJsonPath !== undefined) {
      values.versionJsonPath = input.versionJsonPath;
    }

    if (input.versionHeader !== undefined) {
      values.versionHeader = input.versionHeader;
    }

    if (input.deployedSha !== undefined) {
      values.deployedSha = input.deployedSha;
    }

    if (input.strictVersionMatch !== undefined) {
      values.strictVersionMatch = input.strictVersionMatch;
    }

    if (input.testAccountCredentialId !== undefined) {
      values.testAccountCredentialId = input.testAccountCredentialId;
    }

    if (input.resetEndpoint !== undefined) {
      values.resetEndpoint = input.resetEndpoint;
    }

    if (input.setupScript !== undefined) {
      values.setupScript = input.setupScript;
    }

    if (input.teardownScript !== undefined) {
      values.teardownScript = input.teardownScript;
    }

    if (input.envVarsJson !== undefined) {
      values.envVarsJson = input.envVarsJson;
    }

    if (input.db !== undefined) {
      if (input.db === null) {
        values.dbType = null;
        values.dbHost = null;
        values.dbPort = null;
        values.dbName = null;
        values.dbSchema = null;
        values.dbUser = null;
        values.dbCredentialId = null;
        values.dbSsl = false;
        values.dbIsTest = true;
        values.dbWriteMode = 'readonly';
      } else {
        Object.assign(values, databaseValues(input.db));
      }
    }

    if (input.browserJson !== undefined) {
      values.browserJson = input.browserJson;
    }

    if (input.caseTimeoutMs !== undefined) {
      values.caseTimeoutMs = input.caseTimeoutMs;
    }

    if (input.apiConcurrency !== undefined) {
      values.apiConcurrency = input.apiConcurrency;
    }

    if (input.uiConcurrency !== undefined) {
      values.uiConcurrency = input.uiConcurrency;
    }

    if (input.isDefault !== undefined) {
      values.isDefault = input.isDefault;
    }

    if (input.healthStatus !== undefined) {
      values.healthStatus = input.healthStatus;
    }

    if (input.healthCheckedAt !== undefined) {
      values.healthCheckedAt = input.healthCheckedAt;
    }

    if (input.healthMessage !== undefined) {
      values.healthMessage = input.healthMessage;
    }

    return this.db
      .update(environments)
      .set(values)
      .where(and(eq(environments.id, id), eq(environments.tenantId, this.tenantId)))
      .returning()
      .get();
  }

  remove(id: string): boolean {
    const result = this.db
      .delete(environments)
      .where(and(eq(environments.id, id), eq(environments.tenantId, this.tenantId)))
      .run();

    return result.changes > 0;
  }

  /** 同一项目只保留一个默认环境。 */
  clearDefault(projectId: string, exceptId?: string, now: number = nowMs()): number {
    const conditions = [
      eq(environments.tenantId, this.tenantId),
      eq(environments.projectId, projectId),
      eq(environments.isDefault, true),
    ];

    if (exceptId !== undefined) {
      conditions.push(ne(environments.id, exceptId));
    }

    const result = this.db
      .update(environments)
      .set({ isDefault: false, updatedAt: now })
      .where(and(...conditions))
      .run();

    return result.changes;
  }

  countByCredential(credentialId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(environments)
      .where(
        and(
          eq(environments.tenantId, this.tenantId),
          or(
            eq(environments.testAccountCredentialId, credentialId),
            eq(environments.dbCredentialId, credentialId),
          ),
        ),
      )
      .get();

    return row?.count ?? 0;
  }
}
