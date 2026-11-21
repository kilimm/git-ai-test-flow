// 本文件所有改动要求遵循 agent-rules 规范
import type { DocReferenceIssue } from '@gait/shared';

const REFERENCE_PATTERN = /`([^`\n]{1,200})`/g;
const API_PATTERN = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+\/[^\s]*$/;
const TABLE_PATTERN = /^(?:table:)?([a-z][a-z0-9_]{2,63})$/i;

function looksLikePath(value: string): boolean {
  return (
    /^(?:src|app|apps|packages|services|server|db|docs|features|steps|fixtures|templates)\//.test(
      value,
    ) || /\.(?:ts|tsx|js|mjs|py|go|java|yml|yaml|json|sql|feature|md)$/.test(value)
  );
}

/**
 * 校验文档中反引号引用：
 * - 路径必须存在于仓库文件集合；
 * - API 只标记为 stale（无法从文件集合验证路由）；
 * - 表名以 `table:` 前缀或纯 snake_case 标识，缺少 schema 时标记提示。
 */
export function validateDocReferences(
  content: string,
  repoFiles: ReadonlySet<string>,
  knownTables: ReadonlySet<string> = new Set(),
): DocReferenceIssue[] {
  const issues: DocReferenceIssue[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(REFERENCE_PATTERN)) {
    const reference = match[1]?.trim();

    if (reference === undefined || reference.length === 0 || seen.has(reference)) {
      continue;
    }

    seen.add(reference);

    if (API_PATTERN.test(reference)) {
      issues.push({
        reference,
        kind: 'api',
        stale: false,
        message: 'API 引用需在运行/OpenAPI 中复核',
      });
      continue;
    }

    if (looksLikePath(reference)) {
      const exists = repoFiles.has(reference.replace(/^\.\//, ''));

      if (!exists) {
        issues.push({
          reference,
          kind: 'path',
          stale: true,
          message: '引用的文件在仓库中不存在或已移动',
        });
      }

      continue;
    }

    if (reference.startsWith('table:')) {
      const table = reference.slice('table:'.length);

      if (knownTables.size > 0 && !knownTables.has(table)) {
        issues.push({
          reference,
          kind: 'table',
          stale: true,
          message: '引用的数据表不存在',
        });
      } else {
        issues.push({
          reference,
          kind: 'table',
          stale: false,
          message: '表名引用存在',
        });
      }

      continue;
    }

    const tableMatch = TABLE_PATTERN.exec(reference);

    if (
      tableMatch?.[1] !== undefined &&
      knownTables.size > 0 &&
      reference === tableMatch[1] &&
      !knownTables.has(reference)
    ) {
      issues.push({
        reference,
        kind: 'table',
        stale: true,
        message: '疑似表名不存在',
      });
    }
  }

  return issues;
}
