import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy so the client can call /api and /uploads without CORS fuss.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendTarget = 'http://localhost:8001';
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: parseInt(env.PORT || '3000', 10),
      strictPort: true,
      allowedHosts: true,
      hmr: { clientPort: 443, protocol: 'wss' },
      proxy: {
        '/api': { target: backendTarget, changeOrigin: true },
        '/uploads': { target: backendTarget, changeOrigin: true },
      },
    },
  };
});
