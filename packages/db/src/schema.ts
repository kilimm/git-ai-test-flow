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
  RepairGuardStatus,
  RunCaseStatus,
  RunStatus,
  StepStatus,
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

/** 生成任务：从 diff 到功能点、草稿、校验与审批的持久化状态。 */
export const generations = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'number' }),
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
export const generationFiles = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_generation_files_path').on(table.generationId, table.path),
    index('idx_generation_files_generation').on(table.generationId),
  ],
);

export type GenerationFile = typeof generationFiles.$inferSelect;
export type NewGenerationFile = typeof generationFiles.$inferInsert;

/** Suite 中已索引的 feature 文件；数据库只是索引，Git 仍是事实源。 */
export const featureFiles = sqliteTable(
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
    indexedAt: integer('indexed_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_feature_files_path').on(table.projectId, table.repo, table.path),
    index('idx_feature_files_project').on(table.projectId),
  ],
);

export type FeatureFile = typeof featureFiles.$inferSelect;
export type NewFeatureFile = typeof featureFiles.$inferInsert;

/** 场景索引；status=obsolete 表示源码/文件已消失，但保留历史行。 */
export const testCases = sqliteTable(
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
    status: text('status').notNull().default('active'),
    indexedAt: integer('indexed_at', { mode: 'number' }).notNull(),
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
export const runs = sqliteTable(
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
    baselineEnvironmentId: text('baseline_environment_id').references(() => environments.id, {
      onDelete: 'set null',
    }),
    generationId: text('generation_id').references(() => generations.id, { onDelete: 'set null' }),
    trigger: text('trigger').notNull().default('manual'),
    baseSha: text('base_sha'),
    headSha: text('head_sha').notNull(),
    deployedSha: text('deployed_sha'),
    versionMatch: integer('version_match', { mode: 'boolean' }),
    branch: text('branch'),
    suitesJson: text('suites_json').notNull().default('[]'),
    selectionJson: text('selection_json').notNull().default('{}'),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    statsJson: text('stats_json').notNull().default('{}'),
    workflowThreadId: text('workflow_thread_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    errorJson: text('error_json'),
    createdByUserId: text('created_by_user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    startedAt: integer('started_at', { mode: 'number' }),
    finishedAt: integer('finished_at', { mode: 'number' }),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_runs_idempotency').on(table.idempotencyKey),
    index('idx_runs_project_head').on(table.projectId, table.headSha),
    index('idx_runs_tenant_created').on(table.tenantId, desc(table.createdAt)),
    index('idx_runs_project_created').on(table.projectId, desc(table.createdAt)),
    index('idx_runs_status').on(table.status),
  ],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

/** 场景实例：一次 Run 中发现的单个 Gherkin 场景。 */
export const runCases = sqliteTable(
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
    confidence: integer('confidence', { mode: 'number' }),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
    evidenceJson: text('evidence_json').notNull().default('{}'),
    repairStatus: text('repair_status'),
    startedAt: integer('started_at', { mode: 'number' }),
    finishedAt: integer('finished_at', { mode: 'number' }),
  },
  (table) => [
    index('idx_run_cases_run_status').on(table.runId, table.status),
    index('idx_run_cases_run_case_key').on(table.runId, table.caseKey),
  ],
);

export type RunCase = typeof runCases.$inferSelect;
export type NewRunCase = typeof runCases.$inferInsert;

/** 单步执行结果；step_index 在场景内从 1 开始（含 Background）。 */
export const stepResults = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_step_results_case').on(table.runCaseId)],
);

export type StepResult = typeof stepResults.$inferSelect;
export type NewStepResult = typeof stepResults.$inferInsert;

/** 产物只保存相对路径、MIME、大小与 SHA-256，文件在 DATA_DIR/artifacts 下。 */
export const artifacts = sqliteTable(
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
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    redacted: integer('redacted', { mode: 'boolean' }).notNull().default(false),
    expiresAt: integer('expires_at', { mode: 'number' }),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
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
export const runEvents = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_run_events_seq').on(table.runId, table.seq),
    index('idx_run_events_run').on(table.runId, table.seq),
  ],
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;

/** 修复尝试：P0 只生成建议并记录 guard 结果，不自动修改产品代码。 */
export const repairAttempts = sqliteTable(
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
    appliedCommit: text('applied_commit'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_repair_attempts_case_no').on(table.runCaseId, table.attemptNo),
    index('idx_repair_attempts_case').on(table.runCaseId),
  ],
);

export type RepairAttempt = typeof repairAttempts.$inferSelect;
export type NewRepairAttempt = typeof repairAttempts.$inferInsert;

/** 通知记录：dedupe_key 保证同一 Run + 渠道 + 事件只发送一次。 */
export const notifications = sqliteTable(
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
    sentAt: integer('sent_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notifications_dedupe').on(table.dedupeKey),
    index('idx_notifications_run').on(table.runId),
    index('idx_notifications_project_created').on(table.projectId, desc(table.createdAt)),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

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
