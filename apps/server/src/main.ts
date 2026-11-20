// 本文件所有改动要求遵循 agent-rules 规范
import { existsSync } from 'node:fs';
import { loadEnv } from '@gait/config';
import { buildApp } from './app.js';
import { createGracefulShutdown } from './shutdown.js';

const DEFAULT_LISTEN_HOST = '0.0.0.0';
const ENV_FILE_PATH = '.env';

if (existsSync(ENV_FILE_PATH)) {
  process.loadEnvFile(ENV_FILE_PATH);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });
  const shutdown = createGracefulShutdown(app);

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await app.listen({ host: DEFAULT_LISTEN_HOST, port: env.PORT });
  } catch (error) {
    app.log.error({ err: error }, 'server failed to start');
    await app.close();
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Server failed to start: ${message}\n`);
  process.exitCode = 1;
});
