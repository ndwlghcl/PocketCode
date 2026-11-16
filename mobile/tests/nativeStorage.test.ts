import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: false, get: vi.fn(), set: vi.fn(), secureGet: vi.fn() }));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => h.native },
  registerPlugin: () => ({ dataGet: h.get, dataSet: h.set, secureGet: h.secureGet }),
}));

import { diskStorage, secureStorage } from '../src/native';
import { loadDrafts, upsertDraft } from '../src/storage/draftStore';

beforeEach(() => { vi.resetAllMocks(); h.native = false; });

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

test.each([{}, { value: null }])('原生无草稿返回 %j 时，跨文件读取和首次保存正常', async (missing) => {
  h.native = true;
  const data = new Map<string, string>();
  h.get.mockImplementation(async ({ key }: { key: string }) => data.has(key) ? { value: data.get(key) } : missing);
  h.set.mockImplementation(async ({ key, value }: { key: string; value: string }) => { data.set(key, value); });

  for (const path of ['a.py', '子目录/b.py']) {
    expect(await loadDrafts('p1', path)).toEqual({ activeId: null, drafts: [] });
    await upsertDraft('p1', path, {
      id: 'first', name: '自动草稿', projectId: 'p1', path,
      content: `修改 ${path}`, baseVersion: 'sha256:' + 'a'.repeat(64), savedAt: '2026-11-15T00:00:00Z',
    });
    expect((await loadDrafts('p1', path)).drafts).toEqual([
      expect.objectContaining({ path, content: `修改 ${path}` }),
    ]);
  }
  expect(h.set).toHaveBeenCalledTimes(2);
});

test.each(['', '{broken', '{"drafts":[{"id":"bad","content":"KEEP"}]}'])('原生返回损坏数据 %j 时仍阻止覆盖', async (raw) => {
  h.native = true;
  h.get.mockResolvedValue({ value: raw });
  expect(await diskStorage.get('pc.draft.p1.a.py')).toBe(raw);
  await expect(loadDrafts('p1', 'a.py')).rejects.toThrow();
  await expect(upsertDraft('p1', 'a.py', {
    id: 'new', name: '新草稿', projectId: 'p1', path: 'a.py', content: 'NEW',
    baseVersion: 'sha256:' + 'a'.repeat(64), savedAt: '2026-11-15T00:00:00Z',
  })).rejects.toThrow();
  expect(h.set).not.toHaveBeenCalled();
  expect(await diskStorage.get('pc.draft.p1.a.py')).toBe(raw);
});

test('原生读取失败仍报错，不当成无草稿并写入', async () => {
  h.native = true;
  h.get.mockRejectedValue(new Error('disk read failure'));
  await expect(loadDrafts('p1', 'a.py')).rejects.toThrow('无法读取草稿');
  expect(h.set).not.toHaveBeenCalled();
});

test('安全存储也兼容原生省略空值字段', async () => {
  h.native = true;
  h.secureGet.mockResolvedValue({});
  expect(await secureStorage.get('token')).toBeNull();
});
