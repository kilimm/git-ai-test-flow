// 本文件所有改动要求遵循 agent-rules 规范
import { count, sql } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { runCases, runs } from './schema.js';

export interface DatabaseMetricSnapshot {
  runs: Record<string, number>;
  classifications: Record<string, number>;
}

/** 临时表读写探针：用于 /readyz 验证数据库确实可写，不写入业务表。 */
export function checkDatabaseWritable(db: AppDatabase): void {
  db.run(sql`CREATE TEMP TABLE IF NOT EXISTS _gait_ready_probe (id INTEGER)`);
  db.run(sql`DROP TABLE IF EXISTS temp._gait_ready_probe`);
}

/** Run 与归因分类计数，供 /metrics 使用；全部为只读聚合。 */
export function collectDatabaseMetrics(db: AppDatabase): DatabaseMetricSnapshot {
  const runRows = db
    .select({ status: runs.status, value: count() })
    .from(runs)
    .groupBy(runs.status)
    .all();
  const classificationRows = db
    .select({ classification: runCases.classification, value: count() })
    .from(runCases)
    .where(sql`${runCases.classification} IS NOT NULL`)
    .groupBy(runCases.classification)
    .all();
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
