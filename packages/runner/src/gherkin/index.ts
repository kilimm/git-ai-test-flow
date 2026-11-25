// 本文件所有改动要求遵循 agent-rules 规范
import type { IndexedScenarioInput } from '@gait/db';
import { contentHash, scenarioFingerprint } from './fingerprint.js';
import { parseFeatureSource } from './parse.js';

export interface FeatureFileInput {
  path: string;
  content: string;
  blobSha: string | null;
}

export interface IndexedFeatureFileInput {
  projectId: string;
  repo: string;
  path: string;
  blobSha: string | null;
  moduleKey: string | null;
  tags: string[];
  scenarios: IndexedScenarioInput[];
  parseStatus: 'parsed' | 'invalid';
  parseError: string | null;
}

/**
 * 模块标签允许层级（点分），如 `module:api.messages`；
 * 之前只允许单段，导致层级模块被识别为 'unknown'。
 */
function moduleOf(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const match = /^module:([A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(tag);

    if (match !== null) {
      return match[1] ?? null;
    }
  }

  return null;
}

function caseKeyOf(tags: readonly string[], line: number): string {
  for (const tag of tags) {
    const match = /^case:([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(tag);

    if (match !== null) {
      return match[1] ?? `AUTO-L${line}`;
    }
  }

  return `AUTO-L${line}`;
}

/**
 * 将 Suite 中的 feature 文本转换为索引写入模型。
 * 语法错误的文件保留 parse_status=invalid，不产生场景索引。
 */
export function buildFeatureIndex(
  projectId: string,
  repo: string,
  files: readonly FeatureFileInput[],
): IndexedFeatureFileInput[] {
  return files.map((file) => {
    const parsed = parseFeatureSource(file.content);

    if (parsed.feature === null || parsed.errors.length > 0) {
      return {
        projectId,
        repo,
        path: file.path,
        blobSha: file.blobSha,
        moduleKey: null,
        tags: [],
        scenarios: [],
        parseStatus: 'invalid',
        parseError: parsed.errors.map((error) => error.message).join('; '),
      };
    }

    const fileHash = contentHash(file.content);
    const featureTags = parsed.feature.tags;
    const scenarios = parsed.feature.scenarios.map((scenario) => {
      const tags = [...new Set([...featureTags, ...scenario.tags])];
      const moduleKey = moduleOf(tags) ?? 'unknown';
      const caseKey = caseKeyOf(scenario.tags, scenario.line);
      const fingerprint = scenarioFingerprint({
        moduleKey,
        caseKey,
        name: scenario.name,
        steps: scenario.steps,
      });
      const searchText = [
        scenario.name,
        ...scenario.steps.map((step) => step.text),
        ...tags.map((tag) => tag.replace(/:/g, ' ')),
      ].join('\n');

      return {
        caseKey,
        name: scenario.name,
        line: scenario.line,
        tags,
        contentHash: fileHash,
        fingerprint,
        searchText,
      } satisfies IndexedScenarioInput;
    });

    const firstScenarioModule =
      scenarios.map((scenario) => moduleOf(scenario.tags)).find((value) => value !== null) ?? null;

    return {
      projectId,
      repo,
      path: file.path,
      blobSha: file.blobSha,
      moduleKey: moduleOf(featureTags) ?? firstScenarioModule,
      tags: featureTags,
      scenarios,
      parseStatus: 'parsed',
      parseError: null,
    };
  });
}
