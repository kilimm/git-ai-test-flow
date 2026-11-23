// 本文件所有改动要求遵循 agent-rules 规范
import type { AppDatabase } from './client.js';

export class TenantScopeError extends Error {
  constructor(message = 'A non-empty tenantId is required') {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export abstract class BaseRepository {
  protected constructor(protected readonly db: AppDatabase) {}
}

/**
 * 取出必然存在的行（如 INSERT ... RETURNING）。
 * PostgreSQL 驱动返回数组，这里统一处理空数组并给出明确错误。
 */
export function requireRow<T>(row: T | undefined, message = 'Expected query to return a row'): T {
  if (row === undefined) {
    throw new Error(message);
  }

  return row;
}

/**
 * 租户仓储基类：所有租户表查询都必须从实例携带的 tenantId 派生过滤条件，
 * 禁止从请求参数直接读取 tenant_id。
 */
export abstract class TenantScopedRepository extends BaseRepository {
  protected readonly tenantId: string;

  protected constructor(db: AppDatabase, tenantId: string) {
    super(db);

    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new TenantScopeError();
    }

    this.tenantId = tenantId;
  }
}
