import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// S0：仅构建本地前端资源（webDir=dist 供 Capacitor 打包）。
// 网络层（S1 health 请求）通过 HTTPS fetch 直连电脑，不需要 Vite 代理。
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
});
