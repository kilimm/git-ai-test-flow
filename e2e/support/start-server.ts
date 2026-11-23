// 本文件所有改动要求遵循 agent-rules 规范
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../apps/server/dist/index.js';
import { loadDotEnv, loadEnv } from '../../packages/config/dist/index.js';
import { seedE2E } from './seed.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = join(root, 'data', 'e2e');

/** E2E 必须连接真实 PostgreSQL；不允许回退到 SQLite 或 PGlite。 */
function requireE2EDatabaseUrl(): string {
  const url = process.env['E2E_DATABASE_URL']?.trim();

  if (url === undefined || url.length === 0) {
    process.stderr.write(
      '缺少环境变量 E2E_DATABASE_URL：E2E 需要真实 PostgreSQL 连接串，' +
        '例如 postgresql://user:password@127.0.0.1:5432/gait_e2e\n',
    );
    process.exit(1);
  }

  return url;
}

/** checkpoint 库在业务库名后追加 _checkpoints，满足 env schema 的应用库/checkpoint 库分离要求。 */
function toCheckpointDatabaseUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    // 不打印原始连接串，避免泄露凭据。
    throw new Error('E2E_DATABASE_URL 不是合法的 PostgreSQL 连接串');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  if (databaseName.length === 0) {
    throw new Error(
      'E2E_DATABASE_URL 必须包含数据库名，例如 postgresql://user:password@127.0.0.1:5432/gait_e2e',
    );
  }

  parsed.pathname = `/${databaseName}_checkpoints`;

  return parsed.toString();
}

// 支持把 E2E_DATABASE_URL 写在仓库根 .env；显式导出的环境变量优先。
loadDotEnv(root);

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3100';
process.env['LOG_LEVEL'] = process.env['E2E_LOG_LEVEL'] ?? 'silent';
process.env['DATA_DIR'] = dataDir;
delete process.env['DATABASE_PATH'];
delete process.env['CHECKPOINT_DB_PATH'];
const e2eDatabaseUrl = requireE2EDatabaseUrl();
process.env['DATABASE_URL'] = e2eDatabaseUrl;
process.env['CHECKPOINT_DATABASE_URL'] = toCheckpointDatabaseUrl(e2eDatabaseUrl);
process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 11).toString('base64');
process.env['ENCRYPTION_KEY_VERSION'] = '1';
process.env['SESSION_SECRET'] = 'e2e-session-secret-0123456789abcdef';
process.env['PUBLIC_BASE_URL'] = 'http://127.0.0.1:5173';
process.env['SSRF_ALLOWLIST'] = '127.0.0.1';

await seedE2E();

const env = loadEnv();
const app = await buildApp({ env });

await app.listen({ host: '127.0.0.1', port: 3100 });
process.stdout.write('e2e api listening on http://127.0.0.1:3100\n');

const shutdown = (): void => {
  void app.close().then(() => {
    process.exit(0);
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
