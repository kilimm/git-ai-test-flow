// 本文件所有改动要求遵循 agent-rules 规范

/**
 * 模块识别与模块树。
 * * 设计目标：
 * 1. 层级化：模块 key 用点号分隔，支持嵌套，例如 `posts`、`posts.comments`；
 * 2. 稳定：同一个代码/功能无论来自 LLM 还是路径推断，都必须收敛成同一个 key；
 * 3. 前缀过滤：选择 `posts` 命中 `posts.comments`，选择 `posts.comments` 不影响 `posts`；
 * 4. 正交：模块 key 只表达「功能归属」，不承载风险/颗粒度等信息。
 *
 * key 规则（slug 化）：
 * - 每段转小写；非 [a-z0-9] 连续串折叠为单个 `-`；去掉首尾 `-`；
 * - 原始名称若以分隔符（. / : > 等）分段，则逐段 slug 后以 `.` 连接；
 * - 驼峰会被拆词（`userProfile` → `user-profile`）；
 * - 段为空则丢弃；结果为空时视为无法识别。
 */

export const MODULE_NAME_SEPARATORS = /[./\\:>#\s]+/u;

/** 记录历史模块见到的原始名称，用于前端展示更好的标题。 */
export interface ModuleTreeNode {
  /** 完整层级 key，例如 `posts.comments`。 */
  key: string;
  /** 末级段 slug，例如 `comments`。 */
  name: string;
  /** 展示用名称（优先来自 LLM 的原始写法），例如 `Comments`。 */
  label: string;
  /** 父模块 key；顶层为 null。 */
  parent: string | null;
  /** 子树全部叶子 + 自身的功能点引用数（包含后代）。 */
  featurePoints: number;
  /** 自身直接引用的功能点数量。 */
  direct: number;
  children: ModuleTreeNode[];
}

/** 拆分驼峰/下划线/连字符，得到可用于 slug 的词元。 */
export function splitModuleWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** 单段 slug：`userProfile` → `user-profile`；非 ASCII 字符会被丢弃。 */
export function slugifyModuleSegment(segment: string): string {
  return splitModuleWords(segment)
    .map((word) => word.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter((word) => word.length > 0)
    .join('-');
}

/**
 * 规范化模块 key：
 * - `Posts`、`/posts/`、`posts.comments`、`posts/comments`、`posts > comments` 均收敛；
 * - 保留 LLM 给出的层级结构，多级用 `.` 连接；
 * - 无法识别时返回 null。
 */
export function normalizeModuleKey(raw: string): string | null {
  const segments = raw
    .trim()
    .split(MODULE_NAME_SEPARATORS)
    .map((segment) => slugifyModuleSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return null;
  }

  return segments.join('.');
}

/** 批量规范化 + 去重（保持顺序）。 */
export function normalizeModuleKeys(rawKeys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawKeys) {
    const key = normalizeModuleKey(raw);

    if (key !== null && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }

  return result;
}

/** 展示名：`posts.comments` → `Posts / Comments`（不改变 key）。 */
export function moduleLabel(key: string): string {
  return key
    .split('.')
    .map((segment) => segment.replace(/-/g, ' '))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' / ');
}

/** `candidate` 是否等于 `prefix` 或位于其子树下。 */
export function moduleMatchesPrefix(candidate: string, prefix: string): boolean {
  const normalizedCandidate = normalizeModuleKey(candidate);
  const normalizedPrefix = normalizeModuleKey(prefix);

  if (normalizedCandidate === null || normalizedPrefix === null) {
    return false;
  }

  return (
    normalizedCandidate === normalizedPrefix ||
    normalizedCandidate.startsWith(`${normalizedPrefix}.`)
  );
}

/**
 * selection 过滤：任何一个被选中的模块命中即通过。
 * 空的 selection 表示不限制（全部模块）。
 */
/** 单向前缀匹配：candidate 等于 prefix 或位于其子树下（不反向）。 */
export function matchesModulePrefix(candidate: string, prefix: string): boolean {
  return moduleMatchesPrefix(candidate, prefix);
}

/**
 * selection 过滤（另一种入参形态）：当 selection 作为「候选模块」、
 * modules 作为选中的前缀集合时使用。与 matchesModuleSelection 互为反向：
 * 返回 true 表示 selection 中至少一个 key 命中了某个前缀。
 */
export function matchesModuleSelection(
  modules: readonly string[],
  selection: readonly string[],
): boolean {
  const prefixes = normalizeModuleKeys(selection);

  if (prefixes.length === 0) {
    return true;
  }

  return modules.some((module) => prefixes.some((prefix) => moduleMatchesPrefix(module, prefix)));
}

/** 从 key 推导祖先链：`posts.comments` → ['posts', 'posts.comments']。 */
export function moduleAncestry(key: string): string[] {
  const segments = key.split('.').filter((segment) => segment.length > 0);

  return segments.map((_, index) => segments.slice(0, index + 1).join('.'));
}

/**
 * 由「模块 → 直接功能点数」构建模块树。祖先节点自动补全（即使没有直接功能点），
 * 保证前端可以选择父模块做前缀过滤。
 */
export function buildModuleTree(
  counts: Iterable<{ key: string; count: number }>,
): ModuleTreeNode[] {
  interface Draft {
    key: string;
    direct: number;
    children: Map<string, Draft>;
  }

  const roots = new Map<string, Draft>();

  const ensure = (key: string): Draft => {
    const parts = key.split('.');
    let level = roots;
    let current: Draft | undefined;

    for (const [index, part] of parts.entries()) {
      const currentKey = parts.slice(0, index + 1).join('.');
      let node = level.get(part);

      if (node === undefined) {
        node = { key: currentKey, direct: 0, children: new Map() };
        level.set(part, node);
      }

      current = node;
      level = node.children;
    }

    return current as Draft;
  };

  for (const { key, count } of counts) {
    const normalized = normalizeModuleKey(key);

    if (normalized === null) {
      continue;
    }

    ensure(normalized).direct += Math.max(0, count);
  }

  const toNode = (draft: Draft, parent: string | null): ModuleTreeNode => {
    const children = [...draft.children.values()]
      .map((child) => toNode(child, draft.key))
      .sort((left, right) => left.key.localeCompare(right.key));
    const featurePoints =
      draft.direct + children.reduce((total, child) => total + child.featurePoints, 0);

    return {
      key: draft.key,
      name: draft.key.split('.').at(-1) ?? draft.key,
      label: moduleLabel(draft.key),
      parent,
      featurePoints,
      direct: draft.direct,
      children,
    };
  };

  return [...roots.values()]
    .map((draft) => toNode(draft, null))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** 展平模块树为「叶子优先」的顺序（父在前），便于渲染 antd Tree。 */
export function flattenModuleTree(nodes: readonly ModuleTreeNode[]): ModuleTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenModuleTree(node.children)]);
}
