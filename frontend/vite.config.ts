import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :4000; the proxy keeps requests same-origin so
// no API URL, token or key is ever baked into the frontend bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:4000', changeOrigin: true } },
  },
  build: { sourcemap: false },
});
