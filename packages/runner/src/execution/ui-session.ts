// 本文件所有改动要求遵循 agent-rules 规范
import type { UiDriver } from '../ui/driver.js';

export interface UiSessionResult {
  trace: Buffer | null;
  consoleMessages: string[];
  failureScreenshot: Buffer | null;
}

/** 单场景 UI 会话：首次 UI 步骤时启动浏览器与 Trace，场景结束后统一关闭。 */
export class CaseUiSession {
  private readonly factory: () => Promise<UiDriver>;
  private driverPromise: Promise<UiDriver> | null = null;
  private driver: UiDriver | null = null;
  private traceStarted = false;

  constructor(factory: () => Promise<UiDriver>) {
    this.factory = factory;
  }

  async get(): Promise<UiDriver> {
    if (this.driver !== null) {
      return this.driver;
    }

    if (this.driverPromise === null) {
      this.driverPromise = this.factory();
    }

    const driver = await this.driverPromise;

    this.driver = driver;

    if (!this.traceStarted) {
      await driver.startTrace().catch(() => undefined);
      this.traceStarted = true;
    }

    return driver;
  }

  async screenshot(): Promise<Buffer | null> {
    if (this.driver === null) {
      return null;
    }

    return this.driver.screenshot().catch(() => null);
  }

  async finish(failed: boolean): Promise<UiSessionResult> {
    if (this.driver === null) {
      return { trace: null, consoleMessages: [], failureScreenshot: null };
    }

    const failureScreenshot = failed ? await this.screenshot() : null;
    const trace = await this.driver.stopTrace().catch(() => null);
    const consoleMessages = [...this.driver.consoleMessages()];

    await this.driver.close().catch(() => undefined);
    this.driver = null;

    return { trace, consoleMessages, failureScreenshot };
  }
}
