// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';

export const runParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();

const shaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'Must be a Git commit SHA');

const selectionSchema = z
  .object({
    type: z.enum(['all', 'modules', 'cases']).default('all'),
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
