// 本文件所有改动要求遵循 agent-rules 规范
import type {
  FeatureIndexRepository,
  GenerationFileRepository,
  GenerationRepository,
} from '@gait/db';
import { buildFeatureIndex } from '@gait/runner';
import type { SuiteRepository } from '@gait/git';

export interface ReindexResult {
  files: number;
  scenarios: number;
  missing: number;
}

export interface CommitGenerationInput {
  suite: SuiteRepository;
  featureIndex: FeatureIndexRepository;
  generationRepository: GenerationRepository;
  generationFileRepository: GenerationFileRepository;
  generationId: string;
  projectId: string;
  files: readonly { path: string; content: string }[];
  message: string;
  now: number;
}

export interface CommitGenerationResult {
  commitSha: string;
  changed: boolean;
  committedPaths: string[];
  index: ReindexResult;
}

/** 从 Suite Git 内容重建索引；数据库可随时从仓库重建。 */
export async function reindexSuite(input: {
  suite: SuiteRepository;
  featureIndex: FeatureIndexRepository;
  projectId: string;
}): Promise<ReindexResult> {
  const files = await input.suite.listFeatureFiles();
  const parsed = buildFeatureIndex(input.projectId, 'suite', files);
  let scenarios = 0;

  for (const file of parsed) {
    const result = input.featureIndex.indexFeatureFile(file);
    scenarios += result.active;
  }

  const missing = input.featureIndex.markMissingFiles(
    input.projectId,
    'suite',
    new Set(files.map((file) => file.path)),
  );

  return { files: files.length, scenarios, missing };
}

export function buildGenerationCommitMessage(input: {
  generationId: string;
  headSha: string;
  featurePointIds: readonly string[];
}): string {
  return [
    `test(ai): 生成用例 ${input.headSha.slice(0, 8)}`,
    '',
    `generation-id: ${input.generationId}`,
    `source-commit: ${input.headSha}`,
    `feature-points: ${input.featurePointIds.join(', ')}`,
  ].join('\n');
}

/** 审批通过后的幂等提交：内容未变化时不产生新 commit，但仍更新索引与状态。 */
export async function commitGeneration(
  input: CommitGenerationInput,
): Promise<CommitGenerationResult> {
  const commit = await input.suite.writeAndCommit(input.files, input.message);

  input.generationFileRepository.markAllCommitted(input.generationId, commit.commitSha, input.now);
  const index = await reindexSuite({
    suite: input.suite,
    featureIndex: input.featureIndex,
    projectId: input.projectId,
  });
  input.generationRepository.update(
    input.generationId,
    {
      status: 'committed',
      approvalStatus: 'approved',
      finishedAt: input.now,
    },
    input.now,
  );

  return {
    commitSha: commit.commitSha,
    changed: commit.changed,
    committedPaths: commit.committedPaths,
    index,
  };
}
