/**
 * 界面偏好（S4a）：折叠行开关等阅读界面设置。
 *
 * 走原生文件 KV（与草稿/缓存同通道），不用 localStorage——
 * Android WebView 数据可能被系统清理（架构文档 §6.1 的口径）。
 */

import { diskStorage, type KVStorage } from '../native';

const WRAP_KEY = 'pc.ui.wrap';

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
