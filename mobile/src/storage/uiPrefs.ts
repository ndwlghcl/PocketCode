/**
 * 界面偏好（S4a）：折叠行开关等阅读界面设置。
 *
 * 走原生文件 KV（与草稿/缓存同通道），不用 localStorage——
 * Android WebView 数据可能被系统清理（架构文档 §6.1 的口径）。
 */

import { diskStorage, type KVStorage } from '../native';
import { Capacitor } from '@capacitor/core';

const WRAP_KEY = 'pc.ui.wrap';
// 外观设置需向界面报告落盘失败；浏览器分支不能沿用缓存仓储的静默失败策略。
const preferenceStorage: KVStorage = {
  ...diskStorage,
  async set(key, value) {
    if (Capacitor.isNativePlatform()) await diskStorage.set(key, value);
    else localStorage.setItem(key, value);
  },
};

export interface AppearancePrefs {
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  lineNumbers: boolean;
  wrap: boolean;
  imageOpacity: number;
  maskOpacity: number;
  blur: number;
}
export const APPEARANCE_KEY = 'pc.ui.appearance';
export const DEFAULT_APPEARANCE: AppearancePrefs = {
  theme: 'dark', fontSize: 14, lineNumbers: true, wrap: true,
  imageOpacity: 0.55, maskOpacity: 0.7, blur: 0,
};
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
export function normalizeAppearance(value: unknown): Omit<AppearancePrefs, 'wrap'> {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    theme: raw.theme === 'light' || raw.theme === 'system' ? raw.theme : 'dark',
    fontSize: bounded(raw.fontSize, 14, 11, 24),
    lineNumbers: typeof raw.lineNumbers === 'boolean' ? raw.lineNumbers : true,
    imageOpacity: bounded(raw.imageOpacity, .55, 0, 1),
    maskOpacity: bounded(raw.maskOpacity, .7, 0, 1),
    blur: bounded(raw.blur, 0, 0, 20),
  };
}
export async function loadAppearance(storage: KVStorage = diskStorage): Promise<AppearancePrefs> {
  const wrap = await loadWrapPref(storage);
  try { return { ...normalizeAppearance(JSON.parse(await storage.get(APPEARANCE_KEY) ?? '{}')), wrap }; }
  catch { return { ...DEFAULT_APPEARANCE, wrap }; }
}
export async function saveAppearance(prefs: AppearancePrefs, storage: KVStorage = preferenceStorage): Promise<void> {
  // 折行继续使用既有键，旧版升级无须迁移，也不会出现两套折行配置。
  await storage.set(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(prefs)));
  await storage.set(WRAP_KEY, prefs.wrap ? '1' : '0');
}

export async function loadWrapPref(storage: KVStorage = diskStorage): Promise<boolean> {
  try {
    const raw = await storage.get(WRAP_KEY);
    if (raw === null || raw === undefined) return true; // 默认开启折行（PRD §4.2）
    return raw === '1';
  } catch {
    return true;
  }
}

export async function saveWrapPref(
  value: boolean,
  storage: KVStorage = diskStorage,
): Promise<void> {
  try {
    await storage.set(WRAP_KEY, value ? '1' : '0');
  } catch {
    // 存不进去就退化为本次会话生效
  }
}
