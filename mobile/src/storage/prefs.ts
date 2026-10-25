/**
 * S1 本地偏好：记住上次成功使用的电脑地址。
 *
 * 用 localStorage 即可满足（地址不是机密；S2 配对后的 device_token
 * 必须改用原生安全存储，见架构文档 §1 NativeBridge）。
 * 所有读写都吞掉异常：WebView 隐私模式等场景下 localStorage 可能不可用，
 * 此时退化为“不记住”，绝不阻塞界面。
 */

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const BASE_URL_KEY = 'pocketcode.connection.baseUrl';

function defaultStorage(): PrefsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadBaseUrl(storage: PrefsStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(BASE_URL_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function saveBaseUrl(value: string | null, storage: PrefsStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (value === null) {
      storage.removeItem(BASE_URL_KEY);
    } else {
      storage.setItem(BASE_URL_KEY, value);
    }
  } catch {
    // 存不进去就放弃记忆，不影响功能
  }
}
