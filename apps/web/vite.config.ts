import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// `/api` goes to A's server. Port from SERVER_PORT or PORT (apps/server reads PORT, default 8787).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const serverPort = env.SERVER_PORT ?? env.PORT ?? '8787';
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        '/api': { target: `http://localhost:${serverPort}`, changeOrigin: true },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
