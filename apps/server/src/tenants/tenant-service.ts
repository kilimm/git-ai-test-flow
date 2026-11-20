// 本文件所有改动要求遵循 agent-rules 规范
import { nowMs } from '@gait/config';
import { AuditLogWriter, TenantRepository } from '@gait/db';
import type { AppDatabase } from '@gait/db';
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from '@gait/shared';
import type { TenantSummary } from '@gait/shared';
import type { AuthContext } from '../auth/auth-service.js';

export interface TenantServiceOptions {
  now?: () => number;
}

export class TenantService {
  private readonly now: () => number;
  private readonly tenants: TenantRepository;
  private readonly audit: AuditLogWriter;

  constructor(db: AppDatabase, options: TenantServiceOptions = {}) {
    this.now = options.now ?? nowMs;
    this.tenants = new TenantRepository(db);
    this.audit = new AuditLogWriter(db);
  }

  updateName(context: AuthContext, name: string): TenantSummary {
    const now = this.now();
    const previousName = context.tenant.name;

    this.tenants.updateName(context.tenant.id, name, now);
    this.audit.append({
      tenantId: context.tenant.id,
      actorUserId: context.user.id,
      action: AUDIT_ACTION.TENANT_UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TENANT,
      resourceId: context.tenant.id,
      detail: { previousName, name },
      now,
    });

    return {
      id: context.tenant.id,
      slug: context.tenant.slug,
      name,
      role: context.role,
    };
  }
}
