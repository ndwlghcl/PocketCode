import { describe, expect, it, vi } from 'vitest';

import {
  createPositionSaver,
  loadReadPosition,
  saveReadPosition,
} from '../src/storage/readPositionStore';
import { loadWrapPref, saveWrapPref } from '../src/storage/uiPrefs';
import type { KVStorage } from '../src/native';

/** node 测试环境用内存 KV 模拟原生磁盘存储。 */
function fakeStorage(): KVStorage {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

describe('readPositionStore（阅读位置跨重启持久化，S4a）', () => {
  it('保存后能读回；不同文件互不影响', async () => {
    const storage = fakeStorage();
    await saveReadPosition('p1', 'a.py', 1234, storage);
    await saveReadPosition('p1', 'b.py', 99, storage);

    expect((await loadReadPosition('p1', 'a.py', storage))?.scrollTop).toBe(1234);
    expect((await loadReadPosition('p1', 'b.py', storage))?.scrollTop).toBe(99);
    expect(await loadReadPosition('p2', 'a.py', storage)).toBeNull();
  });

  it('损坏数据与非数字 scrollTop 返回 null', async () => {
    const storage = fakeStorage();
    await storage.set('pc.readpos.p1.a.py', 'not json');
    expect(await loadReadPosition('p1', 'a.py', storage)).toBeNull();
    await storage.set(
      'pc.readpos.p1.a.py',
      JSON.stringify({ scrollTop: 'x' }),
    );
    expect(await loadReadPosition('p1', 'a.py', storage)).toBeNull();
  });

  it('createPositionSaver：500ms 内多次 push 合并为一次写入，flush 立即落盘', async () => {
    vi.useFakeTimers();
    try {
      const storage = fakeStorage();
      const setSpy = vi.spyOn(storage, 'set');
      const saver = createPositionSaver('p1', 'a.py', storage);

      saver.push(10);
      saver.push(20);
      saver.push(30);
      expect(setSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect((await loadReadPosition('p1', 'a.py', storage))?.scrollTop).toBe(30);

      saver.push(40);
      await saver.flush();
      expect((await loadReadPosition('p1', 'a.py', storage))?.scrollTop).toBe(40);
      // flush 后定时器不再触发第二次写
      const callsAfterFlush = setSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600);
      expect(setSpy.mock.calls.length).toBe(callsAfterFlush);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uiPrefs（折行偏好，S4a）', () => {
  it('默认开启折行；保存后读回一致', async () => {
    const storage = fakeStorage();
    expect(await loadWrapPref(storage)).toBe(true);
    await saveWrapPref(false, storage);
    expect(await loadWrapPref(storage)).toBe(false);
    await saveWrapPref(true, storage);
    expect(await loadWrapPref(storage)).toBe(true);
  });

  it('存储不可用时读取退化为默认值', async () => {
    const broken: KVStorage = {
      async get() {
        throw new Error('boom');
      },
      async set() {
        throw new Error('boom');
      },
      async remove() {
        throw new Error('boom');
      },
      async keys() {
        return [];
      },
    };
    expect(await loadWrapPref(broken)).toBe(true);
    await expect(saveWrapPref(false, broken)).resolves.toBeUndefined();
  });
});
