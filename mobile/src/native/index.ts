/**
 * 原生桥接层占位（S2/S3 实现，架构文档 §1 NativeBridge）。
 *
 * 职责边界：
 * - 扫码（配对二维码）
 * - 原生网络与证书绑定（Android WebView 对自签证书不信任时由 Kotlin 桥处理 pinning）
 * - 安全存储（device_token 不进 WebView localStorage）
 * - 系统分享（分享代码片段/文件/ZIP）
 */

export interface NativeBridge {
  scanQrCode(): Promise<string | null>;
  secureStoreGet(key: string): Promise<string | null>;
  secureStoreSet(key: string, value: string): Promise<void>;
  shareText(title: string, text: string): Promise<void>;
}
