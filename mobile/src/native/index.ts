/**
 * 原生桥接层：PocketCodeBridge 插件的 TS 封装。
 *
 * 职责边界（架构文档 §1 NativeBridge）：
 * - request：HTTPS + 证书指纹绑定（自签证书无法被 WebView 信任，必须原生）；
 * - 安全存储：device_token 等敏感值存 EncryptedSharedPreferences，不进
 *   localStorage（ADR-0002）；浏览器开发模式退化为 localStorage 并显式标注。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface BridgeRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** `sha256:<64hex>`；缺省时原生侧只放行 /v1/health。 */
  fingerprint?: string;
  timeoutMs?: number;
}

interface PocketCodeBridgePlugin {
  request(options: BridgeRequestOptions): Promise<{ status: number; body: string }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureRemove(options: { key: string }): Promise<void>;
  openAppSettings(): Promise<void>;
  dataSet(options: { key: string; value: string }): Promise<void>;
  dataGet(options: { key: string }): Promise<{ value: string | null }>;
  dataDelete(options: { key: string }): Promise<void>;
  dataKeys(options: { prefix: string }): Promise<{ keys: string[] }>;
}

export const PocketCodeBridge = registerPlugin<PocketCodeBridgePlugin>(
  'PocketCodeBridge',
);

const SECURE_KEY = 'pocketcode.secure.kv';

/** 简单 KV 安全存储：原生走加密存储；浏览器开发模式退化为 localStorage。 */
export const secureStorage = {
  async set(key: string, value: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await PocketCodeBridge.secureSet({ key: `${SECURE_KEY}.${key}`, value });
      return;
    }
    try {
      localStorage.setItem(`${SECURE_KEY}.${key}`, value);
    } catch {
      // 开发模式存储失败不阻塞功能
    }
  },
  async get(key: string): Promise<string | null> {
    if (Capacitor.isNativePlatform()) {
      const result = await PocketCodeBridge.secureGet({ key: `${SECURE_KEY}.${key}` });
      return result.value;
    }
    try {
      return localStorage.getItem(`${SECURE_KEY}.${key}`);
    } catch {
      return null;
    }
  },
  async remove(key: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await PocketCodeBridge.secureRemove({ key: `${SECURE_KEY}.${key}` });
      return;
    }
    try {
      localStorage.removeItem(`${SECURE_KEY}.${key}`);
    } catch {
      // 忽略
    }
  },
};

/** 相机权限被拒绝（可能是永久拒绝）——界面应提供"打开系统设置"入口。 */
export class CameraPermissionError extends Error {}

/** 扫码配对用（原生相机）；浏览器开发模式返回提示。 */
export async function scanQrCode(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('扫码仅在手机 App 中可用');
  }
  const { BarcodeScanner, BarcodeFormat } = await import(
    '@capacitor-mlkit/barcode-scanning'
  );
  const status = await BarcodeScanner.checkPermissions();
  if (status.camera !== 'granted') {
    const request = await BarcodeScanner.requestPermissions();
    if (request.camera !== 'granted') {
      throw new CameraPermissionError('未授予相机权限，无法扫码');
    }
  }
  const { barcodes } = await BarcodeScanner.scan({
    formats: [BarcodeFormat.QrCode],
  });
  return barcodes[0]?.rawValue ?? null;
}

/** 跳转系统设置（用户可手动开启相机权限）。 */
export async function openAppSettings(): Promise<void> {
  await PocketCodeBridge.openAppSettings();
}

/** 可靠磁盘 KV：原生走应用私有文件目录（草稿/缓存承载层，WebView
 *  localStorage 在 Android 上可能被系统清理，不能承载草稿）；
 *  浏览器开发模式退化为 localStorage。 */
export interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** 按前缀枚举键名（草稿箱跨文件列表用）；实现需保证失败返回空数组而非抛错。 */
  keys(prefix: string): Promise<string[]>;
}

export const diskStorage: KVStorage = {
  async set(key: string, value: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await PocketCodeBridge.dataSet({ key, value });
      return;
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      // 开发模式存储失败不阻塞
    }
  },
  async get(key: string): Promise<string | null> {
    if (Capacitor.isNativePlatform()) {
      const result = await PocketCodeBridge.dataGet({ key });
      return result.value;
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async remove(key: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await PocketCodeBridge.dataDelete({ key });
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
  async keys(prefix: string): Promise<string[]> {
    if (Capacitor.isNativePlatform()) {
      try {
        const result = await PocketCodeBridge.dataKeys({ prefix });
        return result.keys ?? [];
      } catch {
        return [];
      }
    }
    try {
      const found: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null && key.startsWith(prefix)) found.push(key);
      }
      return found.sort();
    } catch {
      return [];
    }
  },
};
