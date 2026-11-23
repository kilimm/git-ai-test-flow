// 本文件所有改动要求遵循 agent-rules 规范
import { sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';

/** 单次检索最多使用的关键词数量，避免产生过多 ILIKE 条件拖慢查询。 */
export const MAX_SEARCH_TOKENS = 8;

/** 转义 LIKE 模式中的通配符与转义符，保证用户输入按字面量匹配。 */
export function escapeLikeToken(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 构造“包含关键词”的 LIKE 模式，配合 `ESCAPE '\'` 使用。 */
export function likePattern(token: string): string {
  return `%${escapeLikeToken(token)}%`;
}

/**
 * 大小写不敏感的包含匹配。token 必须经过本模块转义，
 * 否则 `%`、`_` 会被当作通配符，反斜杠结尾还会触发 PostgreSQL 22025。
 */
export function containsToken(column: SQLWrapper, token: string): SQL {
  return sql`${column} ILIKE ${likePattern(token)} ESCAPE '\\'`;
}
