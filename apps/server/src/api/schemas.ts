// 本文件所有改动要求遵循 agent-rules 规范
import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TENANT_NAME_MAX_LENGTH,
  TENANT_ROLES,
  USERNAME_MAX_LENGTH,
} from '@gait/shared';

const idSchema = z.string().min(1).max(64);

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(USERNAME_MAX_LENGTH),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const switchTenantSchema = z.object({ tenantId: idSchema }).strict();

export const tenantParamsSchema = z.object({ id: idSchema }).strict();

export const memberParamsSchema = z.object({ id: idSchema, userId: idSchema }).strict();

export const updateTenantSchema = z
  .object({ name: z.string().trim().min(1).max(TENANT_NAME_MAX_LENGTH) })
  .strict();

export const addMemberSchema = z
  .object({
    username: z.string().trim().min(1).max(USERNAME_MAX_LENGTH),
    role: z.enum(TENANT_ROLES),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
    displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH).optional(),
    email: z.email().max(254).optional(),
  })
  .strict();

export const updateMemberRoleSchema = z.object({ role: z.enum(TENANT_ROLES) }).strict();

export const auditQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    resourceType: z.string().min(1).max(64).optional(),
  })
  .strict();

export type LoginBody = z.infer<typeof loginSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
export type AddMemberBody = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleSchema>;
