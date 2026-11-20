// 本文件所有改动要求遵循 agent-rules 规范
import { GENERATION_LIMITS } from '@gait/shared';
import type { DiffFile, DiffFileCategory, FilterStats } from '@gait/shared';

const LOCK_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'go.sum',
]);

const BUILD_DIRECTORIES = [
  /(^|\/)(dist|build|coverage|\.next|\.nuxt|out|target|vendor)\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)__generated__\//i,
  /(^|\/)generated\//i,
];

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.jar',
  '.class',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp4',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.wasm',
]);

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.env\./i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
];

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rb)$/i,
];

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const FRONTEND_EXTENSIONS = new Set([
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
]);
const API_HINTS =
  /(^|\/)(controller|controllers|route|routes|handler|handlers|api|apis|dto|dtos|endpoint|endpoints)(\/|\.|$)/i;
const DATABASE_HINTS =
  /(^|\/)(migration|migrations|schema|schemas|sql|db|database|models?|entities)(\/|\.|$)/i;
const FRONTEND_HINTS = /(^|\/)(pages?|components?|views?|layouts?|frontend|web)(\/|\.|$)/i;
const CONFIG_HINTS =
  /(^|\/)(config|configs|settings|\.github)(\/|\.|$)|(^|\/)(tsconfig|vitest|vite|eslint|prettier|playwright)\.[a-z0-9.]+$/i;
const INFRA_HINTS =
  /(^|\/)(docker|k8s|kubernetes|terraform|helm|infra|deploy|ci)(\/|\.|$)|(^|\/)(Dockerfile|Makefile)$/i;
const MINIFIED_PATTERN = /\.min\.(js|css)$/i;

export interface FilterOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface Classification {
  category: DiffFileCategory;
  isDoc: boolean;
  isTest: boolean;
  isOpenApi: boolean;
  isSensitive: boolean;
}

function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  const index = lower.lastIndexOf('.');

  return index === -1 ? '' : lower.slice(index);
}

function isOpenApiPath(path: string): boolean {
  const lower = path.toLowerCase();

  return (
    /(^|\/)(openapi|swagger)([^/]*)(\.(json|ya?ml))?$/i.test(lower) ||
    /(^|\/)openapi\//i.test(lower) ||
    /(^|\/)api-docs?\//i.test(lower)
  );
}

export function classifyDiffFile(file: Pick<DiffFile, 'path'>): Classification {
  const { path } = file;
  const extension = extensionOf(path);
  const isTest = TEST_PATTERNS.some((pattern) => pattern.test(path));
  const isSensitive = SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
  const openApi = isOpenApiPath(path);
  const isDoc = DOC_EXTENSIONS.has(extension) && !openApi;

  if (isSensitive) {
    return { category: 'config', isDoc: false, isTest, isOpenApi: openApi, isSensitive };
  }

  if (isTest) {
    return { category: 'test', isDoc: false, isTest, isOpenApi: openApi, isSensitive };
  }

  if (openApi) {
    return { category: 'api', isDoc: true, isTest, isOpenApi: true, isSensitive };
  }

  if (isDoc) {
    return { category: 'docs', isDoc: true, isTest, isOpenApi: false, isSensitive };
  }

  if (DATABASE_HINTS.test(path) || extension === '.sql') {
    return { category: 'database', isDoc: false, isTest, isOpenApi: false, isSensitive };
  }

  if (API_HINTS.test(path)) {
    return { category: 'api', isDoc: false, isTest, isOpenApi: false, isSensitive };
  }

  if (FRONTEND_HINTS.test(path) || FRONTEND_EXTENSIONS.has(extension)) {
    return { category: 'frontend', isDoc: false, isTest, isOpenApi: false, isSensitive };
  }

  if (CONFIG_HINTS.test(path)) {
    return { category: 'config', isDoc: false, isTest, isOpenApi: false, isSensitive };
  }

  if (INFRA_HINTS.test(path)) {
    return { category: 'infrastructure', isDoc: false, isTest, isOpenApi: false, isSensitive };
  }

  return { category: 'other', isDoc: false, isTest, isOpenApi: false, isSensitive };
}

function skipReasonFor(file: DiffFile, classification: Classification): string | null {
  const name = file.path.split('/').at(-1) ?? file.path;

  if (classification.isSensitive) {
    return 'sensitive';
  }

  if (LOCK_FILES.has(name) || /\.lock$/i.test(name)) {
    return 'lockfile';
  }

  if (BUILD_DIRECTORIES.some((pattern) => pattern.test(file.path)) || MINIFIED_PATTERN.test(name)) {
    return 'generated';
  }

  if (file.binary || BINARY_EXTENSIONS.has(extensionOf(file.path))) {
    return 'binary';
  }

  if (classification.isTest) {
    return 'test';
  }

  return null;
}

const CATEGORY_PRIORITY: Record<DiffFileCategory, number> = {
  api: 0,
  database: 1,
  frontend: 2,
  config: 3,
  docs: 4,
  infrastructure: 5,
  other: 6,
  test: 7,
};

/**
 * 过滤与截断：敏感文件内容永不进入 LLM；锁文件/构建产物/二进制/测试文件跳过；
 * 单文件与总预算超限时记录 truncated，保证可观测。
 */
export function filterDiffFiles(
  files: readonly DiffFile[],
  options: FilterOptions = {},
): {
  files: DiffFile[];
  stats: FilterStats;
} {
  const maxFileBytes = options.maxFileBytes ?? GENERATION_LIMITS.MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? GENERATION_LIMITS.MAX_TOTAL_BYTES;
  const skippedByReason: Record<string, number> = {};
  let totalBytes = 0;
  let includedBytes = 0;
  let includedFiles = 0;
  let skippedFiles = 0;
  let truncatedFiles = 0;
  let sensitiveFiles = 0;

  // 先分类，再按优先级分配总预算；输出仍保持原顺序。
  const prepared = files.map((file) => {
    const classification = classifyDiffFile(file);
    const skipReason = skipReasonFor(file, classification);
    const size = Buffer.byteLength(file.patch, 'utf8');
    totalBytes += size;

    if (classification.isSensitive) {
      sensitiveFiles += 1;
    }

    if (skipReason !== null) {
      skippedByReason[skipReason] = (skippedByReason[skipReason] ?? 0) + 1;
    }

    return { file, classification, skipReason, size };
  });
  const budgetOrder = [...prepared].sort(
    (left, right) =>
      CATEGORY_PRIORITY[left.classification.category] -
      CATEGORY_PRIORITY[right.classification.category],
  );
  const skippedByBudget = new Set<string>();
  let budgetUsed = 0;

  for (const item of budgetOrder) {
    if (item.skipReason !== null) {
      continue;
    }

    if (budgetUsed + item.size > maxTotalBytes) {
      skippedByBudget.add(item.file.path);
      skippedByReason['total-budget'] = (skippedByReason['total-budget'] ?? 0) + 1;
      continue;
    }

    budgetUsed += item.size;
  }

  const result = prepared.map(({ file, classification, skipReason, size }) => {
    const overBudget = skippedByBudget.has(file.path);
    const skipped = skipReason !== null || overBudget;
    const finalSkipReason = skipReason ?? (overBudget ? 'total-budget' : null);
    let patch = file.patch;
    let truncated = false;

    if (classification.isSensitive) {
      patch = '';
    } else if (!skipped && Buffer.byteLength(patch, 'utf8') > maxFileBytes) {
      patch = patch.slice(0, maxFileBytes);
      truncated = true;
      truncatedFiles += 1;
    }

    if (skipped) {
      skippedFiles += 1;
    } else {
      includedFiles += 1;
      includedBytes += Buffer.byteLength(patch, 'utf8');
    }

    return {
      ...file,
      ...classification,
      skipped,
      skipReason: finalSkipReason,
      truncated,
      patch,
      sizeBytes: size,
      hunks: classification.isSensitive ? [] : file.hunks,
    } satisfies DiffFile;
  });

  return {
    files: result,
    stats: {
      totalFiles: files.length,
      includedFiles,
      skippedFiles,
      truncatedFiles,
      sensitiveFiles,
      totalBytes,
      includedBytes,
      skippedByReason,
    },
  };
}
