// 本文件所有改动要求遵循 agent-rules 规范
import { parse, stringify } from 'yaml';
import type { DocModuleDefinition, DocModuleManifest } from '@gait/shared';

const MODULE_KEY_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    : [];
}

function validateModule(value: unknown, index: number): DocModuleDefinition {
  if (value === null || typeof value !== 'object') {
    throw new Error(`modules[${index}] must be an object`);
  }

  const record = value as Record<string, unknown>;
  const key = asString(record['key']).trim();

  if (!MODULE_KEY_PATTERN.test(key)) {
    throw new Error(`modules[${index}].key is invalid`);
  }

  const pathPatterns = asStringArray(record['pathPatterns']);

  if (pathPatterns.length === 0) {
    throw new Error(`modules[${index}].pathPatterns must not be empty`);
  }

  return {
    key,
    name: asString(record['name'], key),
    description: asString(record['description']),
    pathPatterns,
    owner: asString(record['owner']),
    dependsOn: asStringArray(record['dependsOn']),
  };
}

/** 解析 Suite 中的 docs/ai/modules.yaml；严格校验，重复 key 直接拒绝。 */
export function parseModuleManifest(source: string): DocModuleManifest {
  const parsed: unknown = parse(source);
  const modules = (parsed as { modules?: unknown } | null)?.modules;

  if (!Array.isArray(modules)) {
    throw new Error('modules.yaml must contain a modules array');
  }

  const result = modules.map(validateModule);
  const keys = new Set<string>();

  for (const module of result) {
    if (keys.has(module.key)) {
      throw new Error(`Duplicate module key: ${module.key}`);
    }

    keys.add(module.key);
  }

  return { modules: result };
}

export function renderModuleManifest(modules: readonly DocModuleDefinition[]): string {
  return stringify({ modules: modules as DocModuleDefinition[] });
}

/** glob → 正则：支持 **、*、?，不引入第三方 glob 依赖。 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 2;
        continue;
      }

      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += (char ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }

  return new RegExp(`${source}$`);
}

export function moduleForPath(
  modules: readonly DocModuleDefinition[],
  path: string,
): DocModuleDefinition | null {
  const normalized = path.replace(/\\/g, '/');

  for (const module of modules) {
    if (module.pathPatterns.some((pattern) => globToRegExp(pattern).test(normalized))) {
      return module;
    }
  }

  return null;
}

/** 无 manifest 时从常见目录推断候选模块，供人工确认。 */
export function inferModules(paths: readonly string[]): DocModuleDefinition[] {
  const candidates = new Set<string>();

  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    const match = /^(?:src|app|apps|packages|services|server|lib)\/([^/]+)/.exec(normalized);

    if (match?.[1] !== undefined && !match[1].startsWith('.')) {
      candidates.add(match[1].toLowerCase().replace(/[^a-z0-9-_]/g, '-'));
    }
  }

  return [...candidates].sort().map((key) => ({
    key,
    name: key,
    description: `从目录推断的模块：${key}`,
    pathPatterns: [`**/${key}/**`],
    owner: '',
    dependsOn: [],
  }));
}
