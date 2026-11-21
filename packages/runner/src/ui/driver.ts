// 本文件所有改动要求遵循 agent-rules 规范
import type { VisualAgent } from './visual-agent.js';

/** 确定性 UI 驱动接口；便于用真实 Playwright 或测试替身实现。 */
export interface UiDriver {
  /** P1 视觉 Agent；缺少 Midscene/视觉模型时由 agent 步骤报告 VISION_UNAVAILABLE。 */
  readonly visualAgent?: VisualAgent;
  goto(url: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  textContent(selector: string): Promise<string | null>;
  pageText(): Promise<string>;
  waitForLoad(timeoutMs?: number): Promise<void>;
  currentUrl(): string;
  screenshot(): Promise<Buffer>;
  startTrace(): Promise<void>;
  stopTrace(): Promise<Buffer | null>;
  consoleMessages(): readonly string[];
  close(): Promise<void>;
}

export class UiDriverError extends Error {
  readonly code = 'UI_STEP_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UiDriverError';
  }
}

/** 页面地址必须停留在环境 Web 同源，避免步骤把浏览器导航到任意站点。 */
export function resolveUiUrl(webBaseUrl: string, path: string): string {
  const base = new URL(webBaseUrl.endsWith('/') ? webBaseUrl : `${webBaseUrl}/`);

  if (/^https?:\/\//i.test(path)) {
    const absolute = new URL(path);

    if (absolute.origin !== base.origin) {
      throw new UiDriverError('UI navigation must stay on the environment Web origin');
    }

    return absolute.toString();
  }

  return new URL(path.replace(/^\/+/, ''), base).toString();
}
