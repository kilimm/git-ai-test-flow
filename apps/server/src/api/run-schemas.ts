// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';

export const runParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

export const runArtifactParamsSchema = z
  .object({
    id: z.string().min(1).max(64),
    artifactId: z.string().min(1).max(64),
  })
  .strict();

/** 列表分页参数：page 从 1 开始，pageSize 上限 100。 */
export const pageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const runCaseParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const runCaseRepairParamsSchema = z
  .object({ id: z.string().min(1).max(64), repairId: z.string().min(1).max(64) })
  .strict();

const shaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'Must be a Git commit SHA');

const selectionSchema = z
  .object({
    type: z.enum(['all', 'modules', 'cases', 'impact']).default('all'),
    modules: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    caseKeys: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
  })
  .strict();

export const createRunSchema = z
  .object({
    environmentId: z.string().min(1).max(64).optional(),
    baseSha: shaSchema.optional(),
    headSha: shaSchema,
    branch: z.string().trim().min(1).max(255).optional(),
    generationId: z.string().min(1).max(64).optional(),
    selection: selectionSchema.optional(),
  })
  .strict();

export type CreateRunBody = z.infer<typeof createRunSchema>;

export const runReportQuerySchema = z
  .object({
    format: z.enum(['json', 'markdown', 'html', 'junit']).default('json'),
    download: z.enum(['0', '1']).optional(),
  })
  .strict();

export const notificationsQuerySchema = z
  .object({
    runId: z.string().min(1).max(64).optional(),
    projectId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => value.runId !== undefined || value.projectId !== undefined, {
    message: 'runId or projectId is required',
  });
