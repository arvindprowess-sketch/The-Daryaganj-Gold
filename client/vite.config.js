import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy so the client can call /api and /uploads without CORS fuss.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_URL || 'http://localhost:4000', changeOrigin: true },
      '/uploads': { target: process.env.VITE_API_URL || 'http://localhost:4000', changeOrigin: true },
    },
  },
});
