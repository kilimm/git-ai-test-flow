// 本文件所有改动要求遵循 agent-rules 规范
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../apps/server/dist/index.js';
import { loadEnv } from '../../packages/config/dist/index.js';
import { seedE2E } from './seed.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = join(root, 'data', 'e2e');

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3100';
process.env['LOG_LEVEL'] = process.env['E2E_LOG_LEVEL'] ?? 'silent';
process.env['DATA_DIR'] = dataDir;
process.env['DATABASE_PATH'] = join(dataDir, 'app.db');
process.env['CHECKPOINT_DB_PATH'] = join(dataDir, 'checkpoints', 'checkpoints.db');
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
