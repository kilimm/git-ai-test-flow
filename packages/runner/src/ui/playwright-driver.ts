// 本文件所有改动要求遵循 agent-rules 规范
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { redactText } from '../artifacts/redaction.js';
import type { UiDriver } from './driver.js';
import { UiDriverError } from './driver.js';
import { createMidsceneVisualAgent } from './visual-agent.js';
import type { VisualAgent } from './visual-agent.js';

export interface PlaywrightUiOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  timeoutMs?: number;
  trace?: boolean;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_CONSOLE_MESSAGES = 200;

async function firstUsable(page: Page, selector: string): Promise<ReturnType<Page['locator']>> {
  const locator = page.locator(selector);
  const count = await locator.count();

  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);

    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  throw new UiDriverError(`No visible element matched selector: ${selector}`);
}

/** 每个用例独立 Chromium context，cookie/state 不与其他用例共享。 */
export class PlaywrightUiDriver implements UiDriver {
  private readonly page: Page;
  private readonly context: BrowserContext;
  private readonly browser: Browser;
  private readonly messages: string[] = [];
  private readonly traceDir: string;
  private readonly traceEnabled: boolean;
  private traceStarted = false;
  readonly visualAgent: VisualAgent;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    traceDir: string,
    traceEnabled: boolean,
  ) {
    this.visualAgent = createMidsceneVisualAgent(page);
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.traceDir = traceDir;
    this.traceEnabled = traceEnabled;
    page.on('console', (message) => {
      if (this.messages.length < MAX_CONSOLE_MESSAGES) {
        this.messages.push(redactText(`${message.type()}: ${message.text()}`).slice(0, 1_000));
      }
    });
  }

  static async launch(options: PlaywrightUiOptions = {}): Promise<PlaywrightUiDriver> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.timezone === undefined ? {} : { timezoneId: options.timezone }),
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    const timeout = options.timeoutMs ?? 30_000;

    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    const traceDir = mkdtempSync(join(tmpdir(), 'gait-ui-trace-'));

    return new PlaywrightUiDriver(browser, context, page, traceDir, options.trace ?? false);
  }

  async goto(url: string): Promise<void> {
    try {
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });

      if (response !== null && response.status() >= 500) {
        throw new UiDriverError(`Page returned HTTP ${response.status()}: ${url}`);
      }
    } catch (error) {
      if (error instanceof UiDriverError) {
        throw error;
      }

      throw new UiDriverError(
        `Failed to open page: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    const locator = await firstUsable(this.page, selector);

    await locator.fill(value);
  }

  async click(selector: string): Promise<void> {
    const locator = await firstUsable(this.page, selector);

    await locator.click();
  }

  async isVisible(selector: string): Promise<boolean> {
    try {
      const locator = this.page.locator(selector);

      return (await locator.count()) > 0 && (await locator.first().isVisible());
    } catch {
      return false;
    }
  }

  async textContent(selector: string): Promise<string | null> {
    try {
      const locator = this.page.locator(selector).first();

      return (await locator.count()) === 0 ? null : locator.textContent();
    } catch {
      return null;
    }
  }

  async pageText(): Promise<string> {
    return (
      await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 100_000);
  }

  async waitForLoad(timeoutMs = 10_000): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false });
  }

  async startTrace(): Promise<void> {
    if (!this.traceEnabled || this.traceStarted) {
      return;
    }

    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.traceStarted = true;
  }

  async stopTrace(): Promise<Buffer | null> {
    if (!this.traceEnabled || !this.traceStarted) {
      return null;
    }

    this.traceStarted = false;
    const path = join(this.traceDir, 'trace.zip');

    await this.context.tracing.stop({ path });

    return readFileSync(path);
  }

  consoleMessages(): readonly string[] {
    return this.messages;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    rmSync(this.traceDir, { recursive: true, force: true });
  }
}
