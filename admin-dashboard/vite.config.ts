import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // the admin API lives on the existing backend under /admin
    proxy: { '/admin': { target: 'http://localhost:4000', changeOrigin: true } },
  },
});
