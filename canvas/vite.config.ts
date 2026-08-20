import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 开发时前端由 vite 热更，数据仍走真服务端。
  server: { proxy: { '/api': 'http://127.0.0.1:8811' } },
  build: { outDir: 'dist' },
});
