import type { CapacitorConfig } from '@capacitor/cli';

// S2 起全部走 HTTPS（自签证书由原生桥按指纹校验，见 ADR-0004）。
// 明文许可（usesCleartextTraffic / allowMixedContent）已按 ADR-0002 的承诺移除。
const config: CapacitorConfig = {
  appId: 'com.pocketcode.app',
  appName: 'PocketCode',
  webDir: 'dist',
};

export default config;
