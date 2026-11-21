// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';
import {
  CONFIG_NAME_MAX_LENGTH,
  CREDENTIAL_TYPES,
  DATABASE_TYPES,
  DATABASE_WRITE_MODES,
  DEFAULT_API_CONCURRENCY,
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_DOCS_ROOT,
  DEFAULT_FEATURE_ROOT,
  DEFAULT_HEALTHCHECK_TIMEOUT_MS,
  DEFAULT_UI_CONCURRENCY,
  LLM_PROVIDERS,
  LLM_PURPOSES,
  NOTIFICATION_EVENTS,
  PROJECT_ACCESS_MODES,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_ROLES,
  PROJECT_SLUG_MAX_LENGTH,
  REPO_PATH_MAX_LENGTH,
  SECRET_MAX_LENGTH,
  SUITE_MODES,
  VERSION_SOURCES,
  gitRefPolicyIssues,
  isFeishuWebhookUrl,
  normalizeProjectSlug,
  projectSlugPolicyIssues,
  repoRelativePathIssues,
} from '@gait/shared';
import { jsonPathIssues } from '../config/json-path.js';

export const idSchema = z.string().min(1).max(64);
const shortText = (max: number): z.ZodString => z.string().trim().min(1).max(max);

const httpUrlSchema = z
  .url()
  .max(2_048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);

        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === ''
        );
      } catch {
        return false;
      }
    },
    { message: 'URL must be HTTP(S) without embedded credentials' },
  );

const httpsUrlSchema = httpUrlSchema.refine((value) => value.startsWith('https://'), {
  message: 'URL must use HTTPS',
});

const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(REPO_PATH_MAX_LENGTH)
  .refine((value) => repoRelativePathIssues(value).length === 0, {
    message: 'Path must be a safe repository-relative path',
  });

const gitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => gitRefPolicyIssues(value).length === 0, {
    message: 'Default branch is not a valid Git ref',
  });

const isoDateSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid ISO 8601 date' });

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_SLUG_MAX_LENGTH)
  .transform(normalizeProjectSlug)
  .refine((value) => projectSlugPolicyIssues(value).length === 0, {
    message: 'Project slug is invalid',
  });

const jsonObjectSchema = z.record(z.string().max(128), z.unknown());

export const projectParamsSchema = z.object({ id: idSchema }).strict();
export const projectMemberParamsSchema = z.object({ id: idSchema, userId: idSchema }).strict();
export const projectAccessUpdateSchema = z
  .object({ accessMode: z.enum(PROJECT_ACCESS_MODES) })
  .strict();
export const projectMemberAddSchema = z
  .object({
    username: shortText(32).transform((value) => value.toLowerCase()),
    role: z.enum(PROJECT_ROLES),
  })
  .strict();
export const projectMemberUpdateSchema = z.object({ role: z.enum(PROJECT_ROLES) }).strict();
export const credentialParamsSchema = z.object({ id: idSchema }).strict();
export const llmProfileParamsSchema = z.object({ id: idSchema }).strict();
export const environmentParamsSchema = z.object({ id: idSchema }).strict();
export const notificationChannelParamsSchema = z.object({ id: idSchema }).strict();

const projectFields = {
  name: shortText(PROJECT_NAME_MAX_LENGTH),
  slug: slugSchema,
  productRepoUrl: httpUrlSchema,
  defaultBranch: gitRefSchema,
  gitCredentialId: idSchema.nullable(),
  suiteMode: z.enum(SUITE_MODES),
  suiteRepoUrl: httpUrlSchema.nullable(),
  suitePath: repoPathSchema.nullable(),
  featureRoot: repoPathSchema,
  docsRoot: repoPathSchema,
  settings: jsonObjectSchema,
};

const suiteValidation: (value: {
  suiteMode: (typeof SUITE_MODES)[number];
  suiteRepoUrl?: string | null | undefined;
  suitePath?: string | null | undefined;
}) => string | null = (value) => {
  if (value.suiteMode === 'external' && (value.suiteRepoUrl ?? '').length === 0) {
    return 'suiteRepoUrl is required when suiteMode is external';
  }

  if (value.suiteMode !== 'external' && (value.suiteRepoUrl ?? '').length > 0) {
    return 'suiteRepoUrl is only allowed when suiteMode is external';
  }

  if (value.suiteMode !== 'same_repo' && (value.suitePath ?? '').length > 0) {
    return 'suitePath is only allowed when suiteMode is same_repo';
  }

  return null;
};

export const createProjectSchema = z
  .object({
    ...projectFields,
    gitCredentialId: projectFields.gitCredentialId.optional(),
    suiteRepoUrl: projectFields.suiteRepoUrl.optional(),
    suitePath: projectFields.suitePath.optional(),
    suiteMode: projectFields.suiteMode.default('managed'),
    featureRoot: projectFields.featureRoot.default(DEFAULT_FEATURE_ROOT),
    docsRoot: projectFields.docsRoot.default(DEFAULT_DOCS_ROOT),
    settings: projectFields.settings.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = suiteValidation(value);

    if (issue !== null) {
      context.addIssue({ code: 'custom', message: issue, path: ['suiteMode'] });
    }
  });

export const updateProjectSchema = z.object(projectFields).partial().strict();

export const createCredentialSchema = z
  .object({
    name: shortText(CONFIG_NAME_MAX_LENGTH),
    type: z.enum(CREDENTIAL_TYPES),
    username: shortText(128).nullable().optional(),
    secret: z.string().min(1).max(SECRET_MAX_LENGTH),
    expiresAt: isoDateSchema.nullable().optional(),
  })
  .strict();

export const updateCredentialSchema = z
  .object({
    name: shortText(CONFIG_NAME_MAX_LENGTH).optional(),
    username: shortText(128).nullable().optional(),
    secret: z.string().min(1).max(SECRET_MAX_LENGTH).optional(),
    expiresAt: isoDateSchema.nullable().optional(),
  })
  .strict();

export const credentialTestSchema = z
  .object({
    repoUrl: httpUrlSchema.optional(),
  })
  .strict();

const llmParamsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    jsonMode: z.boolean().optional(),
  })
  .strict();

const llmProfileFields = {
  name: shortText(CONFIG_NAME_MAX_LENGTH),
  purpose: z.enum(LLM_PURPOSES),
  provider: z.enum(LLM_PROVIDERS),
  baseUrl: httpUrlSchema,
  model: shortText(200),
  credentialId: idSchema.nullable(),
  params: llmParamsSchema,
  enabled: z.boolean(),
};

export const createLlmProfileSchema = z
  .object({
    ...llmProfileFields,
    credentialId: llmProfileFields.credentialId.optional(),
    params: llmProfileFields.params.default({}),
    enabled: llmProfileFields.enabled.default(true),
  })
  .strict();

export const updateLlmProfileSchema = z.object(llmProfileFields).partial().strict();

const databaseSchema = z
  .object({
    type: z.enum(DATABASE_TYPES),
    host: shortText(255).nullable().optional(),
    port: z.number().int().min(1).max(65_535).nullable().optional(),
    name: shortText(255),
    schema: shortText(128).nullable().optional(),
    user: shortText(128).nullable().optional(),
    credentialId: idSchema.nullable().optional(),
    ssl: z.boolean().default(false),
    isTest: z.boolean(),
    writeMode: z.enum(DATABASE_WRITE_MODES).default('readonly'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type !== 'sqlite' && (value.host ?? '').length === 0) {
      context.addIssue({ code: 'custom', message: 'Database host is required', path: ['host'] });
    }
  });

const browserSchema = z
  .object({
    viewportWidth: z.number().int().min(320).max(3_840).optional(),
    viewportHeight: z.number().int().min(240).max(2_160).optional(),
    headless: z.boolean().optional(),
    locale: shortText(35).optional(),
    timezone: shortText(64).optional(),
  })
  .strict();

const healthcheckSchema = z
  .object({
    url: httpUrlSchema,
    expectedStatus: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(DEFAULT_HEALTHCHECK_TIMEOUT_MS),
  })
  .strict();

const versionSchema = z
  .object({
    source: z.enum(VERSION_SOURCES).default('manual'),
    endpoint: httpUrlSchema.nullable().optional(),
    jsonPath: shortText(200).nullable().optional(),
    header: shortText(128).nullable().optional(),
    deployedSha: shortText(255).nullable().optional(),
    strictVersionMatch: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === 'endpoint') {
      if ((value.endpoint ?? '').length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Version endpoint is required',
          path: ['endpoint'],
        });
      }

      if ((value.jsonPath ?? '').length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Version JSON path is required',
          path: ['jsonPath'],
        });
      } else if (jsonPathIssues(value.jsonPath as string).length > 0) {
        context.addIssue({
          code: 'custom',
          message: 'Version JSON path is invalid',
          path: ['jsonPath'],
        });
      }
    }

    if (value.source === 'header' && (value.header ?? '').length === 0) {
      context.addIssue({ code: 'custom', message: 'Version header is required', path: ['header'] });
    }
  });

const environmentFields = {
  name: shortText(CONFIG_NAME_MAX_LENGTH),
  apiBaseUrl: httpUrlSchema,
  webBaseUrl: httpUrlSchema.nullable(),
  healthcheck: healthcheckSchema.nullable(),
  version: versionSchema,
  testAccountCredentialId: idSchema.nullable(),
  resetEndpoint: httpUrlSchema.nullable(),
  setupScript: repoPathSchema.nullable(),
  teardownScript: repoPathSchema.nullable(),
  envVars: z.record(shortText(128), z.string().max(2_000)),
  db: databaseSchema.nullable(),
  browser: browserSchema,
  caseTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  apiConcurrency: z.number().int().min(1).max(64),
  uiConcurrency: z.number().int().min(1).max(16),
  isDefault: z.boolean(),
  confirmDangerous: z.boolean().optional(),
};

export const createEnvironmentSchema = z
  .object({
    ...environmentFields,
    webBaseUrl: environmentFields.webBaseUrl.optional(),
    healthcheck: environmentFields.healthcheck.optional(),
    version: environmentFields.version.default({
      source: 'manual',
      strictVersionMatch: false,
    }),
    testAccountCredentialId: environmentFields.testAccountCredentialId.optional(),
    resetEndpoint: environmentFields.resetEndpoint.optional(),
    setupScript: environmentFields.setupScript.optional(),
    teardownScript: environmentFields.teardownScript.optional(),
    envVars: environmentFields.envVars.default({}),
    db: environmentFields.db.optional(),
    browser: environmentFields.browser.default({}),
    caseTimeoutMs: environmentFields.caseTimeoutMs.default(DEFAULT_CASE_TIMEOUT_MS),
    apiConcurrency: environmentFields.apiConcurrency.default(DEFAULT_API_CONCURRENCY),
    uiConcurrency: environmentFields.uiConcurrency.default(DEFAULT_UI_CONCURRENCY),
    isDefault: environmentFields.isDefault.default(false),
  })
  .strict();

const versionUpdateSchema = z
  .object({
    source: z.enum(VERSION_SOURCES).optional(),
    endpoint: httpUrlSchema.nullable().optional(),
    jsonPath: shortText(200).nullable().optional(),
    header: shortText(128).nullable().optional(),
    deployedSha: shortText(255).nullable().optional(),
    strictVersionMatch: z.boolean().optional(),
  })
  .strict();

export const updateEnvironmentSchema = z
  .object({
    ...environmentFields,
    version: versionUpdateSchema,
    testAccountCredentialId: idSchema.nullable(),
  })
  .partial()
  .strict();

const notificationChannelFields = {
  name: shortText(CONFIG_NAME_MAX_LENGTH),
  webhookUrl: httpsUrlSchema.refine(isFeishuWebhookUrl, {
    message: 'Webhook must be an HTTPS Feishu/Lark URL',
  }),
  secret: z.string().min(1).max(SECRET_MAX_LENGTH),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).max(NOTIFICATION_EVENTS.length),
  enabled: z.boolean(),
};

export const createNotificationChannelSchema = z
  .object({
    ...notificationChannelFields,
    events: notificationChannelFields.events.refine(
      (events) => new Set(events).size === events.length,
      { message: 'Events must be unique' },
    ),
    enabled: notificationChannelFields.enabled.default(true),
  })
  .strict();

export const updateNotificationChannelSchema = z
  .object({
    ...notificationChannelFields,
    events: notificationChannelFields.events.refine(
      (events) => new Set(events).size === events.length,
      { message: 'Events must be unique' },
    ),
  })
  .partial()
  .strict();

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectSchema>;
export type CreateCredentialBody = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialBody = z.infer<typeof updateCredentialSchema>;
export type CreateLlmProfileBody = z.infer<typeof createLlmProfileSchema>;
export type UpdateLlmProfileBody = z.infer<typeof updateLlmProfileSchema>;
export type CreateEnvironmentBody = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentBody = z.infer<typeof updateEnvironmentSchema>;
export type CreateNotificationChannelBody = z.infer<typeof createNotificationChannelSchema>;
export type UpdateNotificationChannelBody = z.infer<typeof updateNotificationChannelSchema>;
