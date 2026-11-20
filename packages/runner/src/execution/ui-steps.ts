// 本文件所有改动要求遵循 agent-rules 规范
import { AssertionError } from '../http/assertions.js';
import type { StoredArtifact } from '../artifacts/artifact-store.js';
import { resolveUiUrl, UiDriverError } from '../ui/driver.js';
import type { UiDriver } from '../ui/driver.js';
import { resolveText } from './variables.js';
import { StepExecutionError } from './types.js';
import type { StepRuntime, TestAccount } from './types.js';
import type { StepMatch } from '../steps/registry.js';

export interface UiStepResult {
  output: Record<string, unknown>;
  artifacts: StoredArtifact[];
}

const USERNAME_SELECTOR =
  'input[name="username"], #username, [data-testid="username"], input[type="email"]';
const PASSWORD_SELECTOR = 'input[name="password"], #password, [data-testid="password"]';
const SUBMIT_SELECTOR =
  'button[type="submit"], [data-testid="login-submit"], button:has-text("Login"), button:has-text("登录")';

async function requireUi(runtime: StepRuntime): Promise<UiDriver> {
  if (runtime.ui !== null) {
    return runtime.ui;
  }

  if (runtime.uiFactory === null) {
    throw new StepExecutionError('UI_NOT_CONFIGURED', 'UI driver is not available', 'error');
  }

  const driver = await runtime.uiFactory();

  runtime.ui = driver;

  return driver;
}

function requireWebBase(runtime: StepRuntime): string {
  if (runtime.environment.webBaseUrl === null) {
    throw new StepExecutionError(
      'UI_NOT_CONFIGURED',
      'Environment webBaseUrl is required for UI steps',
      'error',
    );
  }

  return runtime.environment.webBaseUrl;
}

function accountFrom(runtime: StepRuntime, name: string): TestAccount {
  const candidate = runtime.variables.secret[name];

  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as { username?: unknown }).username === 'string' &&
    typeof (candidate as { password?: unknown }).password === 'string'
  ) {
    return candidate as TestAccount;
  }

  if (runtime.environment.testAccount !== null) {
    return runtime.environment.testAccount;
  }

  throw new StepExecutionError(
    'UI_CREDENTIAL_MISSING',
    `No test account is available for ${name}`,
    'error',
  );
}

async function login(driver: UiDriver, account: TestAccount, baseUrl: string): Promise<void> {
  await driver.goto(resolveUiUrl(baseUrl, '/login'));
  await driver.fill(USERNAME_SELECTOR, account.username);
  await driver.fill(PASSWORD_SELECTOR, account.password);
  await driver.click(SUBMIT_SELECTOR);
  await driver.waitForLoad(5_000).catch(() => undefined);
}

async function capture(
  runtime: StepRuntime,
  stepIndex: number,
  action: string,
  artifacts: StoredArtifact[],
): Promise<void> {
  if (runtime.ui === null) {
    return;
  }

  try {
    const buffer = await runtime.ui.screenshot();

    artifacts.push(
      runtime.artifacts.writeBuffer(
        'screenshot',
        `step-${stepIndex}-${action}`,
        buffer,
        'image/png',
        {
          url: runtime.ui.currentUrl(),
        },
      ),
    );
  } catch {
    // 截图失败不改变步骤结论。
  }
}

function assertUrlIncludes(driver: UiDriver, path: string): void {
  const expected = path.replace(/^\/+/, '');
  let actualPath: string;

  try {
    actualPath = new URL(driver.currentUrl()).pathname;
  } catch {
    actualPath = driver.currentUrl();
  }

  if (expected.length > 0 && !actualPath.includes(expected)) {
    throw new AssertionError(
      `Expected current URL to include ${expected} but received ${actualPath}`,
      expected,
      actualPath,
    );
  }
}

/** 执行 UI 类步骤；断言失败归 failed，驱动错误归 failed 便于归因。 */
export async function executeUiStep(
  name: string,
  params: readonly string[],
  _match: StepMatch,
  runtime: StepRuntime,
  stepIndex: number,
): Promise<UiStepResult> {
  try {
    if (name === 'open-page') {
      const path = resolveText(runtime, params[0] ?? '');
      const base = requireWebBase(runtime);
      const driver = await requireUi(runtime);

      await driver.goto(resolveUiUrl(base, path));
      await driver.waitForLoad().catch(() => undefined);
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'open-page', artifacts);

      return { output: { url: driver.currentUrl() }, artifacts };
    }

    if (name === 'enter-credentials') {
      const driver = await requireUi(runtime);
      const account = accountFrom(runtime, 'testAccount');

      await driver.fill(USERNAME_SELECTOR, account.username);
      await driver.fill(PASSWORD_SELECTOR, account.password);
      await driver.click(SUBMIT_SELECTOR);
      await driver.waitForLoad(5_000).catch(() => undefined);
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'login', artifacts);

      return { output: { url: driver.currentUrl() }, artifacts };
    }

    if (name === 'enter-explicit-credentials') {
      const driver = await requireUi(runtime);
      const username = resolveText(runtime, params[0] ?? '');
      const password = resolveText(runtime, params[1] ?? '');

      await driver.fill(USERNAME_SELECTOR, username);
      await driver.fill(PASSWORD_SELECTOR, password);
      await driver.click(SUBMIT_SELECTOR);
      await driver.waitForLoad(5_000).catch(() => undefined);
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'login', artifacts);

      return { output: { url: driver.currentUrl() }, artifacts };
    }

    if (name === 'logged-in-as') {
      const accountName = resolveText(runtime, params[0] ?? '');
      const account = accountFrom(runtime, accountName);
      const driver = await requireUi(runtime);

      await login(driver, account, requireWebBase(runtime));
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'template-login', artifacts);

      if (driver.currentUrl().includes('/login')) {
        throw new AssertionError(
          'Login template did not leave the login page',
          'not /login',
          driver.currentUrl(),
        );
      }

      return { output: { account: accountName, url: driver.currentUrl() }, artifacts };
    }

    if (name === 'redirected-to' || name === 'stay-on-page') {
      const driver = await requireUi(runtime);
      const path = resolveText(runtime, params[0] ?? '');

      assertUrlIncludes(driver, path);

      return { output: { url: driver.currentUrl(), path }, artifacts: [] };
    }

    if (name === 'see-error') {
      const driver = await requireUi(runtime);
      const expected = resolveText(runtime, params[0] ?? '');
      const text = await driver.pageText();

      if (!text.includes(expected)) {
        throw new AssertionError(`Expected page to show ${expected}`, expected, text.slice(0, 500));
      }

      return { output: { expected }, artifacts: [] };
    }

    if (name === 'ui-click') {
      const driver = await requireUi(runtime);
      const selector = resolveText(runtime, params[0] ?? '');

      await driver.click(selector);
      await driver.waitForLoad(5_000).catch(() => undefined);
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'click', artifacts);

      return { output: { selector }, artifacts };
    }

    if (name === 'ui-fill') {
      const driver = await requireUi(runtime);
      const selector = resolveText(runtime, params[0] ?? '');
      const value = resolveText(runtime, params[1] ?? '');

      await driver.fill(selector, value);
      const artifacts: StoredArtifact[] = [];

      await capture(runtime, stepIndex, 'fill', artifacts);

      return { output: { selector }, artifacts };
    }

    if (name === 'ui-contains') {
      const driver = await requireUi(runtime);
      const expected = resolveText(runtime, params[0] ?? '');
      const text = await driver.pageText();

      if (!text.includes(expected)) {
        throw new AssertionError(
          `Expected page to contain ${expected}`,
          expected,
          text.slice(0, 500),
        );
      }

      return { output: { expected }, artifacts: [] };
    }

    if (name === 'ui-visible') {
      const driver = await requireUi(runtime);
      const selector = resolveText(runtime, params[0] ?? '');
      const visible = await driver.isVisible(selector);

      if (!visible) {
        throw new AssertionError(`Expected ${selector} to be visible`, true, false);
      }

      return { output: { selector }, artifacts: [] };
    }

    throw new StepExecutionError('STEP_UNSUPPORTED', `Unsupported UI step: ${name}`, 'error');
  } catch (error) {
    if (error instanceof UiDriverError || error instanceof AssertionError) {
      throw error instanceof AssertionError
        ? error
        : new StepExecutionError('UI_STEP_FAILED', error.message, 'failed', { cause: error });
    }

    throw error;
  }
}
