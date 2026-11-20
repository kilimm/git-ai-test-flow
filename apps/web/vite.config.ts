import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedPackageEntry = fileURLToPath(
  new URL('../../packages/shared/src/index.ts', import.meta.url),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@gait/shared': sharedPackageEntry,
    },
  },
  server: {
    proxy: {
      // 开发模式下 API 与 Web 分离部署，统一代理到本地 Fastify。
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
});
