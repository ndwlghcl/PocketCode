import { describe, expect, it } from 'vitest';

import { loadBaseUrl, saveBaseUrl, type PrefsStorage } from '../src/storage/prefs';

function fakeStorage(initial: Record<string, string> = {}): PrefsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('prefs（连接地址记忆）', () => {
  it('保存后能读回', () => {
    const storage = fakeStorage();
    saveBaseUrl('http://10.59.163.124:8765', storage);
    expect(loadBaseUrl(storage)).toBe('http://10.59.163.124:8765');
  });

  it('没有记录时返回 null', () => {
    expect(loadBaseUrl(fakeStorage())).toBeNull();
    expect(loadBaseUrl(null)).toBeNull();
  });

  it('null 清除记录', () => {
    const storage = fakeStorage({ 'pocketcode.connection.baseUrl': 'http://x:1' });
    saveBaseUrl(null, storage);
    expect(loadBaseUrl(storage)).toBeNull();
  });

  it('空串视为未配置', () => {
    const storage = fakeStorage({ 'pocketcode.connection.baseUrl': '   ' });
    expect(loadBaseUrl(storage)).toBeNull();
  });

  it('localStorage 抛异常时静默退化，不阻塞调用方', () => {
    const throwing: PrefsStorage = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
      removeItem: () => {
        throw new Error('private mode');
      },
    };
    expect(loadBaseUrl(throwing)).toBeNull();
    expect(() => saveBaseUrl('http://x:1', throwing)).not.toThrow();
  });
});
