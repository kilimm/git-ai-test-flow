// 本文件所有改动要求遵循 agent-rules 规范
import { desc, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  ApprovalStatus,
  ArtifactType,
  AuditAction,
  Classification,
  CredentialType,
  DatabaseType,
  DatabaseWriteMode,
  GenerationStatus,
  HealthStatus,
  JobStatus,
  LlmProvider,
  LlmPurpose,
  MemberStatus,
  NotificationStatus,
  NotificationTestStatus,
  ProjectAccessMode,
  ProjectRole,
  RepairGuardStatus,
  RepairReviewStatus,
  RunCaseStatus,
  RunStatus,
  StepStatus,
  SuiteMode,
  TenantRole,
  TenantStatus,
  TriggerAction,
  TriggerType,
  UserStatus,
  VersionSource,
} from '@gait/shared';

/** PostgreSQL bytea：Node pg 返回 Buffer，PGlite 返回 Uint8Array，统一归一化为 Buffer。 */
const bytea = customType<{ data: Buffer; driverData: Uint8Array | Buffer }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});

export const CI_PROVIDERS = ['github', 'gitlab'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export const DEFAULT_JOB_MAX_ATTEMPTS = 3;

/**
 * M1 建立租户根表与任务队列表；M2 增加用户、成员、会话与审计表。
 * 项目、运行等业务表随对应里程碑的迁移加入。
 */
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').$type<TenantStatus>().notNull().default('active'),
  settingsJson: text('settings_json').notNull().default('{}'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * 用户是全局身份，不属于任何租户；租户归属由 tenant_members 表达。
 * 用户名统一以小写存储，唯一索引保证全局唯一。
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').$type<UserStatus>().notNull().default('active'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** 用户与租户的成员关系；角色和状态都挂在成员关系上。 */
export const tenantMembers = pgTable(
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
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
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
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: text('tenant_id').references(() => tenants.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
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
export const auditLogs = pgTable(
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
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
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
export const credentials = pgTable(
  'credentials',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    type: text('type').$type<CredentialType>().notNull(),
    username: text('username'),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretIv: bytea('secret_iv').notNull(),
    secretAuthTag: bytea('secret_auth_tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_credentials_tenant_name').on(table.tenantId, table.name),
    index('idx_credentials_tenant').on(table.tenantId),
  ],
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

/** 项目是租户内的配置与运行单元；slug 在同一租户内唯一。 */
export const projects = pgTable(
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
    /** tenant：租户成员均可访问；restricted：仅项目成员访问（M9）。 */
    accessMode: text('access_mode').$type<ProjectAccessMode>().notNull().default('tenant'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_projects_tenant_slug').on(table.tenantId, table.slug),
    index('idx_projects_tenant').on(table.tenantId),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

/** 项目成员：仅用于 restricted 项目的额外访问限制，不放大租户角色权限。 */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<ProjectRole>().notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('idx_project_members_user').on(table.userId),
  ],
);

export type ProjectMember = typeof projectMembers.$inferSelect;
export type NewProjectMember = typeof projectMembers.$inferInsert;

/**
 * LLM Profile 按用途区分（生成/归因/文档/视觉），密钥通过凭据引用，
 * 健康状态只保存最近一次检查结果。
 */
export const llmProfiles = pgTable(
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
    enabled: boolean('enabled').notNull().default(true),
    healthStatus: text('health_status').$type<HealthStatus>().notNull().default('unknown'),
    healthCheckedAt: bigint('health_checked_at', { mode: 'number' }),
    healthMessage: text('health_message'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_llm_profiles_project_name').on(table.projectId, table.name),
    index('idx_llm_profiles_project').on(table.projectId),
    index('idx_llm_profiles_credential').on(table.credentialId),
  ],
);

export type LlmProfile = typeof llmProfiles.$inferSelect;
export type NewLlmProfile = typeof llmProfiles.$inferInsert;

/** 环境分组（M10）：按区域/团队/阶段组织环境；组内可设置默认与配额。 */
export const environmentGroups = pgTable(
  'environment_groups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_environment_groups_project_name').on(table.projectId, table.name),
    index('idx_environment_groups_project').on(table.projectId),
  ],
);

export type EnvironmentGroup = typeof environmentGroups.$inferSelect;

/** 环境描述外部已部署的测试环境，平台不负责部署与启动。 */
export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => environmentGroups.id, { onDelete: 'set null' }),
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
    strictVersionMatch: boolean('strict_version_match').notNull().default(false),
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
    dbSsl: boolean('db_ssl').notNull().default(false),
    dbIsTest: boolean('db_is_test').notNull().default(true),
    dbWriteMode: text('db_write_mode').$type<DatabaseWriteMode>().notNull().default('readonly'),
    browserJson: text('browser_json').notNull().default('{}'),
    caseTimeoutMs: integer('case_timeout_ms').notNull().default(60_000),
    apiConcurrency: integer('api_concurrency').notNull().default(4),
    uiConcurrency: integer('ui_concurrency').notNull().default(1),
    healthStatus: text('health_status').$type<HealthStatus>().notNull().default('unknown'),
    healthCheckedAt: bigint('health_checked_at', { mode: 'number' }),
    healthMessage: text('health_message'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
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
export const notificationChannels = pgTable(
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
    webhookCiphertext: bytea('webhook_ciphertext').notNull(),
    webhookIv: bytea('webhook_iv').notNull(),
    webhookAuthTag: bytea('webhook_auth_tag').notNull(),
    webhookKeyVersion: integer('webhook_key_version').notNull(),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretIv: bytea('secret_iv').notNull(),
    secretAuthTag: bytea('secret_auth_tag').notNull(),
    secretKeyVersion: integer('secret_key_version').notNull(),
    eventsJson: text('events_json').notNull().default('[]'),
    enabled: boolean('enabled').notNull().default(true),
    lastTestedAt: bigint('last_tested_at', { mode: 'number' }),
    lastTestStatus: text('last_test_status')
      .$type<NotificationTestStatus>()
      .notNull()
      .default('unknown'),
    lastTestMessage: text('last_test_message'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notification_channels_project_name').on(table.projectId, table.name),
    index('idx_notification_channels_project').on(table.projectId),
  ],
);

export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;

/** 生成任务：从 diff 到功能点、草稿、校验与审批的持久化状态。 */
export const generations = pgTable(
  'generations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    baseSha: text('base_sha'),
    headSha: text('head_sha').notNull(),
    branch: text('branch'),
    mode: text('mode').notNull().default('range'),
    trigger: text('trigger').notNull().default('manual'),
    status: text('status').$type<GenerationStatus>().notNull().default('queued'),
    approvalStatus: text('approval_status').$type<ApprovalStatus>().notNull().default('pending'),
    featurePointsJson: text('feature_points_json').notNull().default('[]'),
    statsJson: text('stats_json').notNull().default('{}'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    workflowThreadId: text('workflow_thread_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    errorJson: text('error_json'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    finishedAt: bigint('finished_at', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('uq_generations_idempotency').on(table.idempotencyKey),
    index('idx_generations_project_created').on(table.projectId, desc(table.createdAt)),
    index('idx_generations_tenant').on(table.tenantId),
  ],
);

export type Generation = typeof generations.$inferSelect;
export type NewGeneration = typeof generations.$inferInsert;

/** 生成产物文件；审批通过后记录 Suite 提交 SHA。 */
export const generationFiles = pgTable(
  'generation_files',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    generationId: text('generation_id')
      .notNull()
      .references(() => generations.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    action: text('action').notNull().default('create'),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    scenarioCount: integer('scenario_count').notNull().default(0),
    validationStatus: text('validation_status').notNull().default('pending'),
    validationErrorsJson: text('validation_errors_json').notNull().default('[]'),
    committedSha: text('committed_sha'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_generation_files_path').on(table.generationId, table.path),
    index('idx_generation_files_generation').on(table.generationId),
  ],
);

export type GenerationFile = typeof generationFiles.$inferSelect;
export type NewGenerationFile = typeof generationFiles.$inferInsert;

/** Suite 中已索引的 feature 文件；数据库只是索引，Git 仍是事实源。 */
export const featureFiles = pgTable(
  'feature_files',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull().default('suite'),
    path: text('path').notNull(),
    blobSha: text('blob_sha'),
    moduleKey: text('module_key'),
    tagsJson: text('tags_json').notNull().default('[]'),
    scenarioCount: integer('scenario_count').notNull().default(0),
    parseStatus: text('parse_status').notNull().default('parsed'),
    parseError: text('parse_error'),
    indexedAt: bigint('indexed_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_feature_files_path').on(table.projectId, table.repo, table.path),
    index('idx_feature_files_project').on(table.projectId),
  ],
);

export type FeatureFile = typeof featureFiles.$inferSelect;
export type NewFeatureFile = typeof featureFiles.$inferInsert;

/** 场景索引；status=obsolete 表示源码/文件已消失，但保留历史行。 */
export const testCases = pgTable(
  'test_cases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    featureFileId: text('feature_file_id')
      .notNull()
      .references(() => featureFiles.id, { onDelete: 'cascade' }),
    caseKey: text('case_key').notNull(),
    name: text('name').notNull(),
    line: integer('line').notNull().default(1),
    tagsJson: text('tags_json').notNull().default('[]'),
    contentHash: text('content_hash').notNull(),
    fingerprint: text('fingerprint').notNull(),
    searchText: text('search_text').notNull().default(''),
    status: text('status').notNull().default('active'),
    indexedAt: bigint('indexed_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_test_cases_file_case').on(table.featureFileId, table.caseKey),
    index('idx_test_cases_project').on(table.projectId),
    index('idx_test_cases_status').on(table.projectId, table.status),
    index('idx_test_cases_fingerprint').on(table.fingerprint),
  ],
);

export type TestCase = typeof testCases.$inferSelect;
export type NewTestCase = typeof testCases.$inferInsert;

/**
 * 测试运行：目标产品 commit + 环境 + 用例选择。
 * 幂等键 projectId:headSha:selectionHash，重复创建返回已有 Run。
 */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id').references(() => environments.id, {
      onDelete: 'set null',
    }),
    generationId: text('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    trigger: text('trigger').notNull().default('manual'),
    baseSha: text('base_sha'),
    headSha: text('head_sha').notNull(),
    deployedSha: text('deployed_sha'),
    versionMatch: boolean('version_match'),
    branch: text('branch'),
    suitesJson: text('suites_json').notNull().default('[]'),
    selectionJson: text('selection_json').notNull().default('{}'),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    statsJson: text('stats_json').notNull().default('{}'),
    workflowThreadId: text('workflow_thread_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    errorJson: text('error_json'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    startedAt: bigint('started_at', { mode: 'number' }),
    finishedAt: bigint('finished_at', { mode: 'number' }),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_runs_idempotency')
      .on(table.idempotencyKey)
      // 部分唯一：仅约束进行中的运行（queued/running）。
      // 已完成（failed/canceled/succeeded）的运行不占用幂等键，
      // 使得失败后可以用相同参数重新创建运行。
      .where(sql`status in ('queued', 'running')`),
    index('idx_runs_project_head').on(table.projectId, table.headSha),
    index('idx_runs_tenant_created').on(table.tenantId, desc(table.createdAt)),
    index('idx_runs_project_created').on(table.projectId, desc(table.createdAt)),
    index('idx_runs_status').on(table.status),
  ],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

/** 场景实例：一次 Run 中发现的单个 Gherkin 场景。 */
export const runCases = pgTable(
  'run_cases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    caseId: text('case_id').references(() => testCases.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('suite'),
    featurePath: text('feature_path').notNull(),
    scenarioName: text('scenario_name').notNull(),
    line: integer('line').notNull().default(1),
    caseKey: text('case_key'),
    tagsJson: text('tags_json').notNull().default('[]'),
    layer: text('layer'),
    status: text('status').$type<RunCaseStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    classification: text('classification').$type<Classification>(),
    confidence: bigint('confidence', { mode: 'number' }),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    repairStatus: text('repair_status'),
    startedAt: bigint('started_at', { mode: 'number' }),
    finishedAt: bigint('finished_at', { mode: 'number' }),
  },
  (table) => [
    index('idx_run_cases_run_status').on(table.runId, table.status),
    index('idx_run_cases_run_case_key').on(table.runId, table.caseKey),
    index('idx_run_cases_history').on(table.tenantId, table.featurePath, table.scenarioName),
  ],
);

export type RunCase = typeof runCases.$inferSelect;
export type NewRunCase = typeof runCases.$inferInsert;

/** 单步执行结果；step_index 在场景内从 1 开始（含 Background）。 */
export const stepResults = pgTable(
  'step_results',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runCaseId: text('run_case_id')
      .notNull()
      .references(() => runCases.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    keyword: text('keyword').notNull(),
    text: text('text').notNull(),
    type: text('type').notNull(),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    durationMs: integer('duration_ms'),
    inputJson: text('input_json').notNull().default('{}'),
    outputJson: text('output_json').notNull().default('{}'),
    errorJson: text('error_json'),
    artifactsJson: text('artifacts_json').notNull().default('[]'),
    agentMetaJson: text('agent_meta_json'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_step_results_case').on(table.runCaseId)],
);

export type StepResult = typeof stepResults.$inferSelect;
export type NewStepResult = typeof stepResults.$inferInsert;

/** 产物只保存相对路径、MIME、大小与 SHA-256，文件在 DATA_DIR/artifacts 下。 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    runCaseId: text('run_case_id').references(() => runCases.id, { onDelete: 'set null' }),
    stepResultId: text('step_result_id').references(() => stepResults.id, {
      onDelete: 'set null',
    }),
    type: text('type').$type<ArtifactType>().notNull(),
    storage: text('storage').notNull().default('local'),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    redacted: boolean('redacted').notNull().default(false),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_artifacts_run').on(table.runId),
    index('idx_artifacts_run_case').on(table.runCaseId),
    index('idx_artifacts_expires').on(table.expiresAt),
  ],
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

/** Run 事件流：seq 在 Run 内单调递增，供 SSE 断线续传使用。 */
export const runEvents = pgTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  // 唯一索引已覆盖按 (run_id, seq) 的查询与排序，无需再建同列普通索引。
  (table) => [uniqueIndex('uq_run_events_seq').on(table.runId, table.seq)],
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;

/** 修复尝试：P0 只生成建议并记录 guard 结果，不自动修改产品代码。 */
export const repairAttempts = pgTable(
  'repair_attempts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    runCaseId: text('run_case_id')
      .notNull()
      .references(() => runCases.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    originalContent: text('original_content').notNull(),
    patchedContent: text('patched_content'),
    patchDiff: text('patch_diff'),
    repairClass: text('repair_class').notNull(),
    rationale: text('rationale').notNull(),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    model: text('model'),
    guardStatus: text('guard_status').$type<RepairGuardStatus>().notNull().default('blocked'),
    guardFindingsJson: text('guard_findings_json').notNull().default('[]'),
    reviewStatus: text('review_status').$type<RepairReviewStatus>().notNull().default('pending'),
    featurePath: text('feature_path'),
    appliedCommit: text('applied_commit'),
    verifiedAt: bigint('verified_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_repair_attempts_case_no').on(table.runCaseId, table.attemptNo),
    index('idx_repair_attempts_case').on(table.runCaseId),
  ],
);

export type RepairAttempt = typeof repairAttempts.$inferSelect;
export type NewRepairAttempt = typeof repairAttempts.$inferInsert;

/** 通知记录：dedupe_key 保证同一 Run + 渠道 + 事件只发送一次。 */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').references(() => notificationChannels.id, {
      onDelete: 'set null',
    }),
    eventType: text('event_type').notNull(),
    status: text('status').$type<NotificationStatus>().notNull().default('pending'),
    payloadJson: text('payload_json').notNull().default('{}'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    attempts: integer('attempts').notNull().default(0),
    dedupeKey: text('dedupe_key').notNull(),
    sentAt: bigint('sent_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notifications_dedupe').on(table.dedupeKey),
    index('idx_notifications_run').on(table.runId),
    index('idx_notifications_project_created').on(table.projectId, desc(table.createdAt)),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/** CI/PR 集成：用于回写报告评论；token 通过凭据引用，不落明文。 */
export const ciIntegrations = pgTable(
  'ci_integrations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').$type<CiProvider>().notNull(),
    repository: text('repository').notNull(),
    apiBaseUrl: text('api_base_url'),
    tokenCredentialId: text('token_credential_id').references(() => credentials.id),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_ci_integrations_project_name').on(table.projectId, table.name),
    index('idx_ci_integrations_project').on(table.projectId),
  ],
);

export type CiIntegration = typeof ciIntegrations.$inferSelect;

/** 多 Runner 注册表：token 只存哈希，心跳用于调度与运维。 */
export const runnerNodes = pgTable(
  'runner_nodes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    tokenHash: text('token_hash').notNull().unique(),
    capacity: integer('capacity').notNull().default(1),
    status: text('status').notNull().default('offline'),
    version: text('version'),
    lastHeartbeatAt: bigint('last_heartbeat_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_runner_nodes_heartbeat').on(table.lastHeartbeatAt)],
);

export type RunnerNode = typeof runnerNodes.$inferSelect;

/** 租户配额：按日 Run、并发 Run 与月度 LLM token 做硬限制。 */
export const tenantQuotas = pgTable('tenant_quotas', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  maxRunsPerDay: integer('max_runs_per_day').notNull().default(200),
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(5),
  maxLlmTokensPerMonth: integer('max_llm_tokens_per_month').notNull().default(2_000_000),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type TenantQuota = typeof tenantQuotas.$inferSelect;

/** OIDC SSO Provider：client secret 与其他密钥一样使用 AES-256-GCM。 */
export const ssoProviders = pgTable(
  'sso_providers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretCiphertext: bytea('client_secret_ciphertext').notNull(),
    clientSecretIv: bytea('client_secret_iv').notNull(),
    clientSecretAuthTag: bytea('client_secret_auth_tag').notNull(),
    clientSecretKeyVersion: integer('client_secret_key_version').notNull(),
    authorizationEndpoint: text('authorization_endpoint').notNull(),
    tokenEndpoint: text('token_endpoint').notNull(),
    userinfoEndpoint: text('userinfo_endpoint').notNull(),
    scopesJson: text('scopes_json').notNull().default('["openid","email","profile"]'),
    allowedEmailDomainsJson: text('allowed_email_domains_json').notNull().default('[]'),
    defaultRole: text('default_role').$type<TenantRole>().notNull().default('viewer'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_sso_providers_tenant_name').on(table.tenantId, table.name),
    index('idx_sso_providers_tenant').on(table.tenantId),
  ],
);

export type SsoProvider = typeof ssoProviders.$inferSelect;

/** OIDC subject 与平台用户绑定，避免仅靠 email 自动关联错误账号。 */
export const ssoIdentities = pgTable(
  'sso_identities',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => ssoProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastLoginAt: bigint('last_login_at', { mode: 'number' }),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.subject] }),
    uniqueIndex('uq_sso_identities_provider_user').on(table.providerId, table.userId),
  ],
);

export type SsoIdentity = typeof ssoIdentities.$inferSelect;

/** 文档模块：Suite 仓库 docs/ai/modules.yaml 的数据库索引与版本缓存。 */
export const docModules = pgTable(
  'doc_modules',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    pathPatternsJson: text('path_patterns_json').notNull().default('[]'),
    owner: text('owner').notNull().default(''),
    dependsOnJson: text('depends_on_json').notNull().default('[]'),
    /** 检索缓存：名称、描述与最新版本正文拼接，写入时刷新。 */
    searchText: text('search_text').notNull().default(''),
    status: text('status').notNull().default('active'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_modules_project_key').on(table.projectId, table.key),
    index('idx_doc_modules_project').on(table.projectId),
  ],
);

export type DocModule = typeof docModules.$inferSelect;
export type NewDocModule = typeof docModules.$inferInsert;

/** 模块文档版本；Git 为事实源，此表支持搜索、diff 与上下文构建。 */
export const docVersions = pgTable(
  'doc_versions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    docModuleId: text('doc_module_id')
      .notNull()
      .references(() => docModules.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    contentMd: text('content_md').notNull(),
    contentHash: text('content_hash').notNull(),
    summary: text('summary'),
    sourceRefsJson: text('source_refs_json').notNull().default('[]'),
    generated: boolean('generated').notNull().default(true),
    humanEdited: boolean('human_edited').notNull().default(false),
    model: text('model'),
    promptVersion: text('prompt_version'),
    tokenCount: integer('token_count').notNull().default(0),
    status: text('status').notNull().default('draft'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_doc_versions_module_created').on(table.docModuleId, desc(table.createdAt)),
    index('idx_doc_versions_project').on(table.projectId),
  ],
);

export type DocVersion = typeof docVersions.$inferSelect;
export type NewDocVersion = typeof docVersions.$inferInsert;

/** T0 提交条目永久保留，压缩摘要必须从这些原始条目生成。 */
export const docCommitEntries = pgTable(
  'doc_commit_entries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    committedAt: bigint('committed_at', { mode: 'number' }).notNull(),
    author: text('author').notNull(),
    title: text('title').notNull(),
    summaryMd: text('summary_md').notNull(),
    detailMd: text('detail_md').notNull().default(''),
    filesJson: text('files_json').notNull().default('[]'),
    modulesJson: text('modules_json').notNull().default('[]'),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_doc_commit_entries_project_sha').on(table.projectId, table.commitSha),
    index('idx_doc_commit_entries_project_time').on(table.projectId, desc(table.committedAt)),
  ],
);

export type DocCommitEntryRow = typeof docCommitEntries.$inferSelect;
export type NewDocCommitEntry = typeof docCommitEntries.$inferInsert;

/** T1-T3 压缩摘要；source_entry_ids_json 保证可回溯原始 T0。 */
export const docRollups = pgTable(
  'doc_rollups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    docModuleId: text('doc_module_id').references(() => docModules.id, { onDelete: 'cascade' }),
    tier: text('tier').notNull(),
    periodStart: bigint('period_start', { mode: 'number' }).notNull(),
    periodEnd: bigint('period_end', { mode: 'number' }).notNull(),
    commitCount: integer('commit_count').notNull(),
    contentMd: text('content_md').notNull(),
    sourceShaRange: text('source_sha_range').notNull(),
    sourceEntryIdsJson: text('source_entry_ids_json').notNull().default('[]'),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_doc_rollups_project_tier').on(table.projectId, table.tier, table.periodEnd),
  ],
);

export type DocRollupRow = typeof docRollups.$inferSelect;
export type NewDocRollup = typeof docRollups.$inferInsert;

/** 文档同步游标：每个项目一行。 */
export const docSyncState = pgTable('doc_sync_state', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  lastProcessedSha: text('last_processed_sha'),
  lastDocCommitSha: text('last_doc_commit_sha'),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type DocSyncStateRow = typeof docSyncState.$inferSelect;

/** 触发器：Webhook / 部署回调 / 定时；token 只保存 SHA-256。 */
export const triggerConfigs = pgTable(
  'trigger_configs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<TriggerType>().notNull(),
    action: text('action').$type<TriggerAction>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    cron: text('cron'),
    branch: text('branch'),
    environmentId: text('environment_id').references(() => environments.id, {
      onDelete: 'set null',
    }),
    selectionJson: text('selection_json').notNull().default('{}'),
    tokenHash: text('token_hash'),
    lastFiredAt: bigint('last_fired_at', { mode: 'number' }),
    nextRunAt: bigint('next_run_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_trigger_configs_project').on(table.projectId),
    index('idx_trigger_configs_due').on(table.enabled, table.nextRunAt),
    uniqueIndex('uq_trigger_configs_token').on(table.tokenHash),
  ],
);

export type TriggerConfig = typeof triggerConfigs.$inferSelect;
export type NewTriggerConfig = typeof triggerConfigs.$inferInsert;

/**
 * 任务队列。领取与心跳都依赖 `locked_by + lease_expires_at`：
 * Worker 崩溃后，过期租约由清理逻辑回收，不依赖进程内状态。
 */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAfter: bigint('run_after', { mode: 'number' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(DEFAULT_JOB_MAX_ATTEMPTS),
    lockedBy: text('locked_by'),
    leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
    dedupeKey: text('dedupe_key').unique(),
    lastError: text('last_error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_jobs_claim').on(table.status, table.runAfter, desc(table.priority), table.createdAt),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

/**
 * Worker 心跳：/readyz 用最后心跳判断是否仍有 Worker 存活。
 * worker_id 由进程启动时生成，每次轮询与任务执行续租时刷新。
 */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('idle'),
  detailsJson: text('details_json').notNull().default('{}'),
});

export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
export type NewWorkerHeartbeat = typeof workerHeartbeats.$inferInsert;
