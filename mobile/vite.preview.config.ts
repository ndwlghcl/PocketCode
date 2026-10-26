import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 独立设计入口与产物，不覆盖 Capacitor 的 dist 或正式 App。
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    outDir: 'design-preview-dist',
    rollupOptions: { input: 'design-preview.html' },
  },
});
