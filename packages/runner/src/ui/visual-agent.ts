// 本文件所有改动要求遵循 agent-rules 规范

export interface VisualAgentResult {
  ok: boolean;
  description: string;
  raw?: unknown;
}

export interface VisualAgent {
  act(instruction: string): Promise<VisualAgentResult>;
  assert(assertion: string): Promise<VisualAgentResult>;
}

export class VisualAgentUnavailableError extends Error {
  readonly code = 'VISION_UNAVAILABLE';

  constructor(message = 'Vision model or Midscene is not available', options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisualAgentUnavailableError';
  }
}

export class VisualAssertionError extends Error {
  readonly code = 'VISUAL_ASSERTION_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VisualAssertionError';
  }
}

type MidsceneModule = {
  PlaywrightAgent?: new (page: unknown) => {
    aiAct?: (instruction: string) => Promise<unknown>;
    aiAssert?: (assertion: string) => Promise<unknown>;
  };
  Agent?: new (page: unknown) => {
    aiAct?: (instruction: string) => Promise<unknown>;
    aiAssert?: (assertion: string) => Promise<unknown>;
  };
};

export type MidsceneLoader = () => Promise<MidsceneModule>;

const defaultLoader: MidsceneLoader = async () => {
  const moduleName = '@midscene/web/playwright';

  try {
    return (await import(moduleName)) as MidsceneModule;
  } catch (error) {
    throw new VisualAgentUnavailableError(
      'Midscene is not installed; add @midscene/web and configure a vision LLM Profile',
      { cause: error },
    );
  }
};

function resultText(value: unknown): string {
  if (typeof value === 'string') {
    return value.slice(0, 2_000);
  }

  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

/**
 * Midscene 适配器：按需动态加载，找不到依赖时在执行 [agent] 步骤时返回
 * `VISION_UNAVAILABLE`，不把 UI 场景降级为 skipped。缺少视觉模型时同样失败，
 * 由归因标记为环境/配置问题并等待人工处理。
 */
export function createMidsceneVisualAgent(
  page: unknown,
  loader: MidsceneLoader = defaultLoader,
): VisualAgent {
  let agentPromise: Promise<{
    aiAct?: (instruction: string) => Promise<unknown>;
    aiAssert?: (assertion: string) => Promise<unknown>;
  }> | null = null;

  const getAgent = async (): Promise<{
    aiAct?: (instruction: string) => Promise<unknown>;
    aiAssert?: (assertion: string) => Promise<unknown>;
  }> => {
    if (agentPromise === null) {
      agentPromise = loader().then((module) => {
        const Constructor = module.PlaywrightAgent ?? module.Agent;

        if (Constructor === undefined) {
          throw new VisualAgentUnavailableError('Midscene does not export a Playwright agent');
        }

        return new Constructor(page);
      });
    }

    return agentPromise;
  };

  return {
    async act(instruction: string): Promise<VisualAgentResult> {
      const agent = await getAgent();

      if (agent.aiAct === undefined) {
        throw new VisualAgentUnavailableError('Midscene agent does not support aiAct');
      }

      try {
        const value = await agent.aiAct(instruction);

        return { ok: true, description: resultText(value), raw: value };
      } catch (error) {
        throw new VisualAssertionError(
          `Visual action failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },

    async assert(assertion: string): Promise<VisualAgentResult> {
      const agent = await getAgent();

      if (agent.aiAssert === undefined) {
        throw new VisualAgentUnavailableError('Midscene agent does not support aiAssert');
      }

      try {
        const value = await agent.aiAssert(assertion);

        return { ok: true, description: resultText(value), raw: value };
      } catch (error) {
        throw new VisualAssertionError(
          `Visual assertion failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  };
}
