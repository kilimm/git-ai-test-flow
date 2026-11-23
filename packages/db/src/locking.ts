// 本文件所有改动要求遵循 agent-rules 规范
import { eq } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { tenants } from './schema.js';

/**
 * 在事务内锁住租户行，串行化同一租户的“先检查后写入”操作
 * （例如 Run 配额校验与插入、最后一个 owner 校验与降级）。
 * 事务提交或回滚后锁自动释放。
 */
export async function withTenantLock<T>(
  db: AppDatabase,
  tenantId: string,
  fn: (tx: AppDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('update');

    if (tenant === undefined) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    return fn(tx as unknown as AppDatabase);
  });
}
