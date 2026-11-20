// 本文件所有改动要求遵循 agent-rules 规范
import { desc } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AuditAction,
  CredentialType,
  DatabaseType,
  DatabaseWriteMode,
  HealthStatus,
  JobStatus,
  LlmProvider,
  LlmPurpose,
  MemberStatus,
  NotificationTestStatus,
  SuiteMode,
  TenantRole,
  TenantStatus,
  UserStatus,
  VersionSource,
} from '@gait/shared';

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;

/**
 * M1 建立租户根表与任务队列表；M2 增加用户、成员、会话与审计表。
 * 项目、运行等业务表随对应里程碑的迁移加入。
 */
export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').$type<TenantStatus>().notNull().default('active'),
  settingsJson: text('settings_json').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * 用户是全局身份，不属于任何租户；租户归属由 tenant_members 表达。
 * 用户名统一以小写存储，唯一索引保证全局唯一。
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').$type<UserStatus>().notNull().default('active'),
  isPlatformAdmin: integer('is_platform_admin', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: integer('last_login_at', { mode: 'number' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** 用户与租户的成员关系；角色和状态都挂在成员关系上。 */
export const tenantMembers = sqliteTable(
  'tenant_members',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<TenantRole>().notNull(),
    status: text('status').$type<MemberStatus>().notNull().default('active'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index('idx_tenant_members_user').on(table.userId),
  ],
);

export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;

/**
 * 会话只保存 token 的 SHA-256 哈希，不保存明文 token。
 * expires_at 为绝对过期时间；last_seen_at 用于 24 小时空闲过期。
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: text('tenant_id').references(() => tenants.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'number' }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_sessions_user').on(table.userId),
    index('idx_sessions_expires').on(table.expiresAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * 审计日志 append-only。tenant_id 允许为空：失败登录尚未解析出租户时仍需记录。
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').references(() => tenants.id),
    actorUserId: text('actor_user_id').references(() => users.id),
    action: text('action').$type<AuditAction>().notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    detailJson: text('detail_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_audit_logs_tenant_created').on(table.tenantId, desc(table.createdAt)),
    index('idx_audit_logs_action').on(table.action),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * 凭据属于租户而不是项目：同一 Git/LLM/测试账号凭据可被多个项目复用。
 * 明文永不落库，只保存 AES-256-GCM 密文、IV、认证标签与密钥版本。
 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    type: text('type').$type<CredentialType>().notNull(),
    username: text('username'),
    secretCiphertext: blob('secret_ciphertext', { mode: 'buffer' }).notNull(),
    secretIv: blob('secret_iv', { mode: 'buffer' }).notNull(),
    secretAuthTag: blob('secret_auth_tag', { mode: 'buffer' }).notNull(),
    keyVersion: integer('key_version').notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_credentials_tenant_name').on(table.tenantId, table.name),
    index('idx_credentials_tenant').on(table.tenantId),
  ],
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

/** 项目是租户内的配置与运行单元；slug 在同一租户内唯一。 */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    productRepoUrl: text('product_repo_url').notNull(),
    defaultBranch: text('default_branch').notNull(),
    gitCredentialId: text('git_credential_id').references(() => credentials.id),
    suiteMode: text('suite_mode').$type<SuiteMode>().notNull().default('managed'),
    suiteRepoUrl: text('suite_repo_url'),
    suitePath: text('suite_path'),
    featureRoot: text('feature_root').notNull().default('features/'),
    docsRoot: text('docs_root').notNull().default('docs/ai/'),
    settingsJson: text('settings_json').notNull().default('{}'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_projects_tenant_slug').on(table.tenantId, table.slug),
    index('idx_projects_tenant').on(table.tenantId),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

/**
 * LLM Profile 按用途区分（生成/归因/文档/视觉），密钥通过凭据引用，
 * 健康状态只保存最近一次检查结果。
 */
export const llmProfiles = sqliteTable(
  'llm_profiles',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    purpose: text('purpose').$type<LlmPurpose>().notNull(),
    provider: text('provider').$type<LlmProvider>().notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    credentialId: text('credential_id').references(() => credentials.id),
    paramsJson: text('params_json').notNull().default('{}'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    healthStatus: text('health_status').$type<HealthStatus>().notNull().default('unknown'),
    healthCheckedAt: integer('health_checked_at', { mode: 'number' }),
    healthMessage: text('health_message'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_llm_profiles_project_name').on(table.projectId, table.name),
    index('idx_llm_profiles_project').on(table.projectId),
    index('idx_llm_profiles_credential').on(table.credentialId),
  ],
);

export type LlmProfile = typeof llmProfiles.$inferSelect;
export type NewLlmProfile = typeof llmProfiles.$inferInsert;

/** 环境描述外部已部署的测试环境，平台不负责部署与启动。 */
export const environments = sqliteTable(
  'environments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    apiBaseUrl: text('api_base_url').notNull(),
    webBaseUrl: text('web_base_url'),
    healthcheckUrl: text('healthcheck_url'),
    healthcheckExpectedStatus: integer('healthcheck_expected_status').notNull().default(200),
    healthcheckTimeoutMs: integer('healthcheck_timeout_ms').notNull().default(5_000),
    versionSource: text('version_source').$type<VersionSource>().notNull().default('manual'),
    versionEndpoint: text('version_endpoint'),
    versionJsonPath: text('version_json_path'),
    versionHeader: text('version_header'),
    deployedSha: text('deployed_sha'),
    strictVersionMatch: integer('strict_version_match', { mode: 'boolean' })
      .notNull()
      .default(false),
    testAccountCredentialId: text('test_account_credential_id').references(() => credentials.id),
    resetEndpoint: text('reset_endpoint'),
    setupScript: text('setup_script'),
    teardownScript: text('teardown_script'),
    envVarsJson: text('env_vars_json').notNull().default('{}'),
    dbType: text('db_type').$type<DatabaseType>(),
    dbHost: text('db_host'),
    dbPort: integer('db_port'),
    dbName: text('db_name'),
    dbSchema: text('db_schema'),
    dbUser: text('db_user'),
    dbCredentialId: text('db_credential_id').references(() => credentials.id),
    dbSsl: integer('db_ssl', { mode: 'boolean' }).notNull().default(false),
    dbIsTest: integer('db_is_test', { mode: 'boolean' }).notNull().default(true),
    dbWriteMode: text('db_write_mode').$type<DatabaseWriteMode>().notNull().default('readonly'),
    browserJson: text('browser_json').notNull().default('{}'),
    caseTimeoutMs: integer('case_timeout_ms').notNull().default(60_000),
    apiConcurrency: integer('api_concurrency').notNull().default(4),
    uiConcurrency: integer('ui_concurrency').notNull().default(1),
    healthStatus: text('health_status').$type<HealthStatus>().notNull().default('unknown'),
    healthCheckedAt: integer('health_checked_at', { mode: 'number' }),
    healthMessage: text('health_message'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_environments_project_name').on(table.projectId, table.name),
    index('idx_environments_project').on(table.projectId),
    index('idx_environments_db_credential').on(table.dbCredentialId),
    index('idx_environments_test_account').on(table.testAccountCredentialId),
  ],
);

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;

/**
 * 飞书通知渠道：Webhook 与签名 Secret 都视为密钥，
 * 与普通凭据使用同一套 AES-256-GCM 存储格式。
 */
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    webhookCiphertext: blob('webhook_ciphertext', { mode: 'buffer' }).notNull(),
    webhookIv: blob('webhook_iv', { mode: 'buffer' }).notNull(),
    webhookAuthTag: blob('webhook_auth_tag', { mode: 'buffer' }).notNull(),
    webhookKeyVersion: integer('webhook_key_version').notNull(),
    secretCiphertext: blob('secret_ciphertext', { mode: 'buffer' }).notNull(),
    secretIv: blob('secret_iv', { mode: 'buffer' }).notNull(),
    secretAuthTag: blob('secret_auth_tag', { mode: 'buffer' }).notNull(),
    secretKeyVersion: integer('secret_key_version').notNull(),
    eventsJson: text('events_json').notNull().default('[]'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastTestedAt: integer('last_tested_at', { mode: 'number' }),
    lastTestStatus: text('last_test_status')
      .$type<NotificationTestStatus>()
      .notNull()
      .default('unknown'),
    lastTestMessage: text('last_test_message'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notification_channels_project_name').on(table.projectId, table.name),
    index('idx_notification_channels_project').on(table.projectId),
  ],
);

export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;

/**
 * SQLite 任务队列。领取与心跳都依赖 `locked_by + lease_expires_at`：
 * Worker 崩溃后，过期租约由清理逻辑回收，不依赖进程内状态。
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAfter: integer('run_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(DEFAULT_JOB_MAX_ATTEMPTS),
    lockedBy: text('locked_by'),
    leaseExpiresAt: integer('lease_expires_at'),
    dedupeKey: text('dedupe_key').unique(),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_jobs_claim').on(table.status, table.runAfter, desc(table.priority), table.createdAt),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
