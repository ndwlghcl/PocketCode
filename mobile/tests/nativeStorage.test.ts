import { afterEach, expect, test, vi } from 'vitest';
import { diskStorage } from '../src/native';

afterEach(() => vi.unstubAllGlobals());

test('浏览器存储读、删、枚举失败必须向草稿层报告', async () => {
  vi.stubGlobal('localStorage', {
    getItem() { throw new Error('read failure'); },
    removeItem() { throw new Error('delete failure'); },
    get length() { throw new Error('list failure'); },
  });
  await expect(diskStorage.get('pc.draft.p.a')).rejects.toThrow('read failure');
  await expect(diskStorage.remove('pc.draft.p.a')).rejects.toThrow('delete failure');
  await expect(diskStorage.keys('pc.draft.')).rejects.toThrow('list failure');
});
