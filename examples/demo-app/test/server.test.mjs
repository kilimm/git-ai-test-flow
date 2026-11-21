// 本文件所有改动要求遵循 agent-rules 规范
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createDemoServer } from '../server.mjs';

let app;
let baseUrl;

before(async () => {
  app = createDemoServer({
    username: 'demo',
    password: 'demo-password-123',
    deployedSha: 'abc1234',
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

async function login() {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo-password-123' }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  return body.token;
}

test('health and version endpoints expose deployment metadata', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const version = await fetch(`${baseUrl}/api/version`);
  assert.equal(version.status, 200);
  assert.equal((await version.json()).sha, 'abc1234');
});

test('login rejects invalid credentials and accepts the demo account', async () => {
  const invalid = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'wrong' }),
  });
  assert.equal(invalid.status, 401);

  const token = await login();
  assert.ok(token.length > 20);
});

test('posts API is paginated and requires authentication', async () => {
  const anonymous = await fetch(`${baseUrl}/api/posts`);
  assert.equal(anonymous.status, 401);

  const token = await login();
  const response = await fetch(`${baseUrl}/api/posts?page=1&pageSize=10`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.page, 1);
  assert.equal(body.total, 1);
  assert.equal(body.items[0].title, 'Hello demo');
});

test('empty title reproduces the intentional 500 bug', async () => {
  const token = await login();
  const response = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  });

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'INTERNAL');
});

test('creating a post persists it', async () => {
  const token = await login();
  const created = await fetch(`${baseUrl}/api/posts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'My post', body: 'Body' }),
  });

  assert.equal(created.status, 201);

  const list = await fetch(`${baseUrl}/api/posts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await list.json();

  assert.ok(body.items.some((item) => item.title === 'My post'));
});

test('login page uses stable test IDs and posts page has data-testid list', async () => {
  const loginPage = await (await fetch(`${baseUrl}/`)).text();
  assert.match(loginPage, /data-testid="username"/);
  assert.match(loginPage, /data-testid="password"/);
  assert.match(loginPage, /data-testid="login-submit"/);

  const postsPage = await (await fetch(`${baseUrl}/posts`)).text();
  assert.match(postsPage, /data-testid="post-list"/);
});
