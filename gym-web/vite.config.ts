/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM-safe __dirname (package.json has "type": "module")
const dirname = path.dirname(fileURLToPath(import.meta.url));

// Environment loading — ALL config comes from the repo root .env (two levels
// up from this file), so a single file configures the mobile app, the backend
// and this portal. Precedence: process env > root .env.[mode] > root .env.
// Without a .env everything still runs with the local defaults below.
const REPO_ROOT = path.resolve(dirname, '..');

export default defineConfig(({ mode }) => {
  // Dev-proxy/backend vars from the root .env
  const env = loadEnv(mode, REPO_ROOT, 'GYMWEB_');
  // client-exposed build-time vars (VITE_*)
  const envVite = loadEnv(mode, REPO_ROOT, 'VITE_');

  // Dev proxy target (where /auth and /gym are forwarded). Default keeps the
  // historical localhost:4000 behaviour so `npm run dev` works with zero setup.
  const proxyTarget = env.GYMWEB_PROXY_TARGET || 'http://localhost:4000';

  // Client-side API base for PRODUCTION builds. Empty = same-origin deploy
  // (the portal is served behind a reverse proxy that forwards /auth and /gym).
  // Set e.g. VITE_API_BASE_URL=https://api.example.com to deploy the static
  // bundle against a remote backend (the backend has permissive CORS).
  const apiBaseUrl = (envVite.VITE_API_BASE_URL || '').replace(/\/+$/, '');

  return {
    plugins: [react()],
    // expose VITE_* vars from the ROOT .env to client code (import.meta.env)
    envDir: REPO_ROOT,
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    },
    server: {
      port: Number(env.GYMWEB_PORT) || 5174,
      // GYMWEB_HOST — bind address override (e.g. 0.0.0.0 inside containers
      // or preview environments where the dev server must accept external
      // traffic). Unset keeps Vite's localhost-only default.
      host: env.GYMWEB_HOST || undefined,
      // GYMWEB_ALLOWED_HOSTS=1 disables the Host-header check for dev-server
      // requests — required when the server is reached through a preview/
      // reverse-proxy hostname instead of localhost.
      allowedHosts: env.GYMWEB_ALLOWED_HOSTS === '1' ? true : undefined,
      proxy: {
        '/auth': { target: proxyTarget, changeOrigin: true },
        '/gym': { target: proxyTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
