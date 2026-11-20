// 本文件所有改动要求遵循 agent-rules 规范
import { createHash } from 'node:crypto';
import type { FeatureDraft } from '@gait/shared';
import type { ParsedStep } from './parse.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function contentHash(content: string): string {
  return sha256(content.replace(/\r\n/g, '\n'));
}

function normalizeStep(step: ParsedStep): string {
  return `${step.keyword.toUpperCase()} ${step.text.replace(/\s+/g, ' ').trim()}`;
}

/** 场景指纹：module + case key + 场景名 + 归一化步骤。 */
export function scenarioFingerprint(input: {
  moduleKey: string;
  caseKey: string;
  name: string;
  steps: readonly ParsedStep[];
}): string {
  return sha256(
    [
      input.moduleKey,
      input.caseKey,
      input.name.trim(),
      input.steps.map(normalizeStep).join('\n'),
    ].join('\n'),
  );
}

export function draftFingerprints(draft: FeatureDraft): string[] {
  return [contentHash(draft.content)];
}
