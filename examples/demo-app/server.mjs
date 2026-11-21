// 本文件所有改动要求遵循 agent-rules 规范
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8080;
const DEFAULT_USERNAME = 'demo';
const DEFAULT_PASSWORD = 'demo-password-123';
const SESSION_TTL_MS = 60 * 60 * 1_000;

function env(name, fallback) {
  const value = process.env[name];

  return value === undefined || value.length === 0 ? fallback : value;
}

function json(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(payload);
}

function html(response, body) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > limit) {
      throw new Error('Request body is too large');
    }

    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  if (text.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(text);

  return parsed !== null && typeof parsed === 'object' ? parsed : {};
}

/**
 * 示例被测应用。它只由外部 CI/CD 部署，平台不会启动或构建本文件。
 * 故意保留空标题返回 500 的历史缺陷，用于验收 code_bug 归因。
 */
export function createDemoServer(options = {}) {
  const username = options.username ?? env('DEMO_USERNAME', DEFAULT_USERNAME);
  const password = options.password ?? env('DEMO_PASSWORD', DEFAULT_PASSWORD);
  const deployedSha = options.deployedSha ?? env('DEPLOYED_SHA', 'dev');
  const database = new DatabaseSync(options.dbPath ?? env('DB_PATH', ':memory:'));

  database.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  const seed = database.prepare('SELECT COUNT(*) AS count FROM posts').get();

  if ((seed?.count ?? 0) === 0) {
    database
      .prepare('INSERT INTO posts (id, title, body, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), 'Hello demo', 'Seed post for UI verification', username, Date.now());
  }

  const sessions = new Map();

  function issueSession() {
    const token = createHmac('sha256', randomUUID()).update(randomUUID()).digest('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);

    return token;
  }

  function authenticated(request) {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expiresAt = sessions.get(token);

    if (expiresAt === undefined) {
      return false;
    }

    if (expiresAt <= Date.now()) {
      sessions.delete(token);
      return false;
    }

    return true;
  }

  function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);

    return a.length === b.length && timingSafeEqual(a, b);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(response, 200, { status: 'ok', service: 'demo-app' });
      }

      if (request.method === 'GET' && url.pathname === '/api/version') {
        return json(response, 200, {
          sha: deployedSha,
          service: 'demo-app',
          deployedAt: env('DEPLOYED_AT', new Date(0).toISOString()),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(request);

        if (
          typeof body.username !== 'string' ||
          typeof body.password !== 'string' ||
          !safeEqual(body.username, username) ||
          !safeEqual(body.password, password)
        ) {
          return json(response, 401, { error: 'INVALID_CREDENTIALS' });
        }

        return json(response, 200, { token: issueSession(), user: { username } });
      }

      if (request.method === 'GET' && url.pathname === '/api/posts') {
        if (!authenticated(request)) {
          return json(response, 401, { error: 'AUTH_REQUIRED' });
        }

        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
        const pageSize = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get('pageSize') ?? 20) || 20),
        );
        const total = database.prepare('SELECT COUNT(*) AS count FROM posts').get().count;
        const items = database
          .prepare(
            'SELECT id, title, body, author, created_at FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?',
          )
          .all(pageSize, (page - 1) * pageSize);

        return json(response, 200, {
          page,
          pageSize,
          total,
          items: items.map((row) => ({
            id: row.id,
            title: row.title,
            body: row.body,
            author: row.author,
            createdAt: new Date(row.created_at).toISOString(),
          })),
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/posts') {
        if (!authenticated(request)) {
          return json(response, 401, { error: 'AUTH_REQUIRED' });
        }

        const body = await readJson(request);

        // 故意缺陷：缺少标题时应返回 400，当前直接抛错由外层转成 500。
        if (typeof body.title !== 'string' || body.title.trim().length === 0) {
          throw new Error('title is required');
        }

        const post = {
          id: randomUUID(),
          title: body.title.trim(),
          body: typeof body.body === 'string' ? body.body : '',
          author: username,
          createdAt: new Date().toISOString(),
        };

        database
          .prepare('INSERT INTO posts (id, title, body, author, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(post.id, post.title, post.body, post.author, Date.now());

        return json(response, 201, { post });
      }

      if (request.method === 'GET' && url.pathname === '/') {
        return html(response, loginPage());
      }

      if (request.method === 'GET' && url.pathname === '/posts') {
        return html(response, postsPage());
      }

      return json(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      // 故意保留为 500，供失败的 posts 用例产生 code_bug 证据。
      return json(response, 500, {
        error: 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    server,
    database,
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          database.close();
          resolve();
        });
      });
    },
  };
}

function loginPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo Login</title>
<style>body{font-family:system-ui;background:#f6f8fa;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:32px;width:320px}label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;padding:8px;border:1px solid #d0d7de;border-radius:6px;box-sizing:border-box}button{margin-top:16px;width:100%;padding:9px;border:0;border-radius:6px;background:#1f883d;color:#fff;font-weight:600}#error{color:#cf222e;font-size:13px;min-height:18px}</style></head>
<body><main><h1>Demo App</h1><p>已部署版本示例</p>
<label for="username">用户名</label><input id="username" name="username" data-testid="username" autocomplete="username">
<label for="password">密码</label><input id="password" name="password" data-testid="password" type="password" autocomplete="current-password">
<button type="submit" data-testid="login-submit">登录</button><p id="error" role="alert"></p>
<script>document.querySelector('button').addEventListener('click',async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})});if(!r.ok){document.querySelector('#error').textContent='用户名或密码错误';return}const d=await r.json();sessionStorage.setItem('demo_token',d.token);location.href='/posts'})</script>
</main></body></html>`;
}

function postsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo Posts</title>
<style>body{font-family:system-ui;background:#f6f8fa;margin:0;padding:32px}main{max-width:720px;margin:auto;background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:24px}li{padding:12px 0;border-bottom:1px solid #d8dee4}.muted{color:#57606a;font-size:13px}</style></head>
<body><main data-testid="posts-page"><h1>帖子</h1><form id="create"><input name="title" data-testid="post-title" placeholder="标题"><button type="submit" data-testid="post-submit">创建</button></form><p class="muted" id="status"></p><ul data-testid="post-list"></ul></main>
<script>const token=sessionStorage.getItem('demo_token');if(!token)location.href='/';document.querySelectorAll('input[name=title]').forEach(el=>el.required=true);async function load(){const r=await fetch('/api/posts',{headers:{authorization:'Bearer '+token}});if(r.status===401){location.href='/';return}const d=await r.json();document.querySelector('[data-testid=post-list]').innerHTML=d.items.map(p=>'<li><strong>'+p.title.replace(/[<>&]/g,'')+'</strong><div class="muted">'+p.author+'</div></li>').join('')}document.querySelector('#create').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/api/posts',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('[name=title]').value})});document.querySelector('#status').textContent=r.ok?'已创建':'创建失败';await load()});load()</script>
</body></html>`;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(env('PORT', String(DEFAULT_PORT)));
  const app = createDemoServer();

  app.server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`demo-app listening on ${port} (sha=${env('DEPLOYED_SHA', 'dev')})\n`);
  });

  const stop = () => {
    void app.close().then(() => process.exit(0));
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
