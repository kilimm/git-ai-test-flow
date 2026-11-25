// 本文件所有改动要求遵循 agent-rules 规范
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    aiAct?: (instruction: string, options?: ActOptions) => Promise<unknown>;
    aiAssert?: (assertion: string) => Promise<unknown>;
  }> | null = null;

  const getAgent = async (): Promise<{
    aiAct?: (instruction: string, options?: ActOptions) => Promise<unknown>;
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
        // 「上传/选择本地图片」类指令优先用 Playwright 直接 setInputFiles：
        // Midscene 的文件选择器只在弹窗时生效，而很多页面用隐藏 <input type=file> 配 label，
        // 点击 label 不产生 filechooser 事件时视觉规划会反复失败。
        // 先把本地图片注入页面（远端浏览器无法用 setInputFiles），再让视觉模型完成
        // 剩余动作与断言；注入失败不影响后续视觉尝试。
        await uploadImageFile(page as UploadPage | null, instruction);

        const value = await agent.aiAct(instruction, actOptionsOf(instruction));

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

/** 页面 Playwright Page 的最小接口（只用到文件上传与读取能力）。 */
interface UploadPage {
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * 通过页面里的 <input type=file> 直接注入图片并触发 change。
 *
 * 为什么不用 locator.setInputFiles：本项目的 UI 用例跑在「浏览器与 worker 分属
 * 不同机器」的场景里（UI base URL 指向远端），Playwright 的文件路径无法被远端
 * 浏览器读取。这里把图片转成 base64 在页面内构造 File/DataTransfer，再触发
 * change 事件，页面自己的压缩逻辑照常运行。
 */
async function uploadImageFile(
  page: UploadPage | null,
  instruction: string,
): Promise<string | null> {
  // 注意：不能只看关键词再上传——「选择…图片并等待压缩完成」这类指令后面还要求
  // 观察结果，直接返回成功会跳过后续视觉步骤。这里只上传，仍把指令交给视觉模型。
  if (page === null || !IMAGE_UPLOAD_INTENT.test(instruction)) {
    return null;
  }

  const uploadFile = pickUploadFile(instruction);

  if (uploadFile === null) {
    return null;
  }

  try {
    const base64 = readFileSync(uploadFile).toString('base64');
    const fileName = basename(uploadFile);
    const injected = await page.evaluate(
      (arg: { base64: string; fileName: string }) => {
        // 该函数在浏览器上下文执行（Node 端不加载 DOM lib），故用局部声明而非 DOM 类型。
        const doc = (globalThis as unknown as { document: { querySelector(selector: string): unknown } })
          .document;
        const input = doc.querySelector('input[type="file"]') as {
          files: unknown;
          dispatchEvent(event: unknown): void;
        } | null;

        if (input === null) {
          return false;
        }

        const binary = atob(arg.base64);
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const browser = globalThis as unknown as {
          File: new (parts: unknown[], name: string, options: { type: string }) => unknown;
          DataTransfer: new () => { items: { add(item: unknown): void }; files: unknown };
          Event: new (type: string, options: { bubbles: boolean }) => unknown;
        };
        const file = new browser.File([bytes], arg.fileName, { type: 'image/png' });
        const transfer = new browser.DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new browser.Event('change', { bubbles: true }));

        return true;
      },
      { base64, fileName },
    );

    if (!injected) {
      return null;
    }

    // 页面端压缩（canvas → dataURL）是异步的，给一点时间再让后续断言接手。
    await page.waitForTimeout(1500);

    return `已注入本地图片 ${fileName} 并触发页面选择事件`;
  } catch {
    return null;
  }
}

/** Midscene aiAct 的可选项（只声明我们使用的字段，避免耦合其完整类型）。 */
interface ActOptions {
  fileChooserAccept?: string | string[];
  fileChooserAllowedDir?: string;
}

const IMAGE_UPLOAD_INTENT = /上传|选择.{0,6}(图片|文件)|upload|choose.{0,10}file|attach/i;

/**
 * 视觉动作里出现「上传/选择文件」类意图时，放行允许的目录与文件类型。
 *
 * 注意：`fileChooserAccept` 必须传**真实存在的文件路径**（Midscene 会在弹出
 * file chooser 时直接 accept 这些路径），传 MIME 类型会直接报错，因此这里
 * 从 MIDSCENE_FILE_CHOOSER_DIR 里挑出第一张图片。目录缺失/无图片时只设置
 * allowedDir，让模型可用 RegisterFileChooserAccept 动作自行登记。
 */
function actOptionsOf(instruction: string): ActOptions | undefined {
  if (!IMAGE_UPLOAD_INTENT.test(instruction)) {
    return undefined;
  }

  const allowedDir = process.env.MIDSCENE_FILE_CHOOSER_DIR ?? process.cwd();
  const uploadFile = firstImageIn(allowedDir);

  return {
    fileChooserAllowedDir: allowedDir,
    ...(uploadFile === null ? {} : { fileChooserAccept: uploadFile }),
  };
}

/**
 * 选择上传文件：指令里写了 `宽高为 1200x900` 这类尺寸时，优先挑文件名匹配
 * （sample-1200x900.png）的图片，让页面拿到的比例/尺寸与用例描述一致；
 * 否则取目录里第一张图。
 */
function pickUploadFile(instruction: string): string | null {
  const directory = process.env.MIDSCENE_FILE_CHOOSER_DIR ?? process.cwd();
  const images = listImages(directory);
  const size = /(\d{2,5})\s*[x×*]\s*(\d{2,5})/.exec(instruction);

  if (size !== null) {
    const wanted = `${size[1]}x${size[2]}`;
    const matched = images.find((file) => file.includes(wanted));

    if (matched !== undefined) {
      return matched;
    }
  }

  return images[0] ?? null;
}

/** 列出目录内的图片绝对路径（找不到返回空数组）。 */
function listImages(directory: string): string[] {
  try {
    const files = readdirSync(directory, { recursive: true }) as string[];

    return files
      .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
      .map((file) => join(directory, file));
  } catch {
    return [];
  }
}

/** 在目录中找一张可用图片（png/jpg/webp/gif），找不到返回 null。 */
function firstImageIn(directory: string): string | null {
  try {
    const files = readdirSync(directory, { recursive: true }) as string[];
    const image = files.find((file) => /\.(png|jpe?g|webp|gif)$/i.test(file));

    return image === undefined ? null : join(directory, image);
  } catch {
    return null;
  }
}
