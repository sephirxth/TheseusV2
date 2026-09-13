import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // In dev the frontend hot-reloads via vite; data still goes through the real server.
  server: { proxy: { '/api': 'http://127.0.0.1:8811' } },
  build: { outDir: 'dist' },
});
