// 本文件所有改动要求遵循 agent-rules 规范
import { count, isNotNull } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { runCases, runs } from './schema.js';

export interface DatabaseMetricSnapshot {
  runs: Record<string, number>;
  classifications: Record<string, number>;
}

/** 只读探针：执行 `SELECT 1` 验证数据库可连接，不写入任何业务表。 */
export async function checkDatabaseWritable(db: AppDatabase): Promise<void> {
  await db.execute('select 1');
}

/** Run 与归因分类计数，供 /metrics 使用；全部为只读聚合。 */
export async function collectDatabaseMetrics(db: AppDatabase): Promise<DatabaseMetricSnapshot> {
  const runRows = await db
    .select({ status: runs.status, value: count() })
    .from(runs)
    .groupBy(runs.status);
  const classificationRows = await db
    .select({ classification: runCases.classification, value: count() })
    .from(runCases)
    .where(isNotNull(runCases.classification))
    .groupBy(runCases.classification);
  const runCounts: Record<string, number> = {};

  for (const row of runRows) {
    runCounts[row.status] = row.value;
  }

  const classifications: Record<string, number> = {};

  for (const row of classificationRows) {
    if (row.classification !== null) {
      classifications[row.classification] = row.value;
    }
  }

  return { runs: runCounts, classifications };
}
