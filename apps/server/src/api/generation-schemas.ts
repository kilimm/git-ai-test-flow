// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';

export const generationParamsSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const generationFileParamsSchema = z
  .object({ id: z.string().min(1).max(64), fileId: z.string().min(1).max(64) })
  .strict();

const shaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'Must be a Git commit SHA');

export const createGenerationSchema = z
  .object({
    mode: z.enum(['current', 'range', 'baseline']).default('range'),
    /** 用例生成颗粒度；仅对生成密度生效，默认 medium。 */
    granularity: z.enum(['high', 'medium', 'low']).default('medium'),
    baseSha: shaSchema.optional(),
    headSha: shaSchema.optional(),
    branch: z.string().trim().min(1).max(255).optional(),
    selection: z
      .object({
        modules: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'baseline') {
      // baseline 忽略 diff，只需确定分析目标（branch 或 headSha），baseSha 由服务端固定为空树。
      if (value.baseSha !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseSha'],
          message: 'baseSha is not allowed in baseline mode',
        });
      }

      if (value.headSha === undefined && value.branch === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['branch'],
          message: 'branch or headSha is required for baseline mode',
        });
      }

      return;
    }

    if (value.mode === 'range') {
      if (value.baseSha === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseSha'],
          message: 'baseSha is required for range mode',
        });
      }

      if (value.headSha === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['headSha'],
          message: 'headSha is required for range mode',
        });
      }
    } else if (value.headSha === undefined && value.branch === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['branch'],
        message: 'branch or headSha is required for current mode',
      });
    }
  });

export const editGenerationFileSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024),
  })
  .strict();

export const approveGenerationSchema = z
  .object({ message: z.string().trim().min(1).max(500).optional() })
  .strict();

export const rejectGenerationSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export type CreateGenerationBody = z.infer<typeof createGenerationSchema>;
export type EditGenerationFileBody = z.infer<typeof editGenerationFileSchema>;
export type ApproveGenerationBody = z.infer<typeof approveGenerationSchema>;
export type RejectGenerationBody = z.infer<typeof rejectGenerationSchema>;
