import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DEFAULT_PROXY_TARGET = 'http://127.0.0.1:8000';

export default defineConfig(() => {
  // Development proxy target for `npm run dev`. The browser always uses relative
  // paths, so it never needs to know where the API or Ollama live.
  const proxyTarget = process.env.VITE_DEV_API_PROXY ?? DEFAULT_PROXY_TARGET;

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/health': proxyTarget,
        '/api': proxyTarget,
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
