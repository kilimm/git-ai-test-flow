#!/usr/bin/env node
// 本文件所有改动要求遵循 agent-rules 规范

const baseUrl = process.env.DEMO_BASE_URL;
const expectedSha = process.env.DEMO_DEPLOYED_SHA;
const username = process.env.DEMO_USERNAME ?? 'demo';
const password = process.env.DEMO_PASSWORD ?? 'demo-password-123';

if (baseUrl === undefined || baseUrl.length === 0) {
  process.stderr.write(
    'DEMO_BASE_URL is required, e.g. DEMO_BASE_URL=https://demo.example.com pnpm smoke:p0\n',
  );
  process.exit(1);
}

const base = baseUrl.replace(/\/+$/, '');
const checks = [];

async function check(name, fn) {
  const startedAt = Date.now();

  try {
    const detail = await fn();
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt, detail });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

await check('health', async () => {
  const response = await fetch(`${base}/healthz`);

  if (!response.ok) {
    throw new Error(`health returned ${response.status}`);
  }

  return await response.json();
});

await check('version', async () => {
  const response = await fetch(`${base}/api/version`);

  if (!response.ok) {
    throw new Error(`version returned ${response.status}`);
  }

  const body = await response.json();

  if (expectedSha !== undefined && body.sha !== expectedSha) {
    throw new Error(`deployed sha ${body.sha} does not match expected ${expectedSha}`);
  }

  return body;
});

let token;

await check('login', async () => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(`login returned ${response.status}`);
  }

  token = (await response.json()).token;

  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('login did not return a token');
  }

  return { authenticated: true };
});

await check('posts pagination', async () => {
  const response = await fetch(`${base}/api/posts?page=1&pageSize=10`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`posts returned ${response.status}`);
  }

  const body = await response.json();

  if (!Array.isArray(body.items) || body.page !== 1) {
    throw new Error('posts response shape is invalid');
  }

  return { total: body.total, pageSize: body.pageSize };
});

await check('login page selectors', async () => {
  const response = await fetch(`${base}/`);

  if (!response.ok) {
    throw new Error(`login page returned ${response.status}`);
  }

  const text = await response.text();

  for (const selector of ['data-testid="username"', 'data-testid="login-submit"']) {
    if (!text.includes(selector)) {
      throw new Error(`login page is missing ${selector}`);
    }
  }

  return { selectors: 'present' };
});

const report = {
  baseUrl: base,
  expectedSha: expectedSha ?? null,
  generatedAt: new Date().toISOString(),
  ok: checks.every((item) => item.ok),
  checks,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
