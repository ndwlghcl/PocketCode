import { beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('../src/storage/cacheStore', () => ({ loadCachedFile: h.load, saveCachedFile: h.save }));
import { PocketCodeError } from '../src/api/client';
import { prepareBundle } from '../src/features/sharing/prepareBundle';

beforeEach(() => { vi.resetAllMocks(); h.load.mockResolvedValue(null); });
const data = (path: string, content = 'code') => ({ path, content, version: 'sha256:a', mtime: '2026-11-03T00:00:00Z' } as any);

test('在线读取与离线回退分别标注来源，断线后不为每个文件重复等超时', async () => {
  const readFile = vi.fn(async (_id: string, path: string) => {
    if (path === 'a.py') return data(path);
    throw new PocketCodeError(0, 'OFFLINE', '电脑断开');
  });
  h.load.mockImplementation(async (_id, path) => ({ data: data(path, 'cached'), fetchedAt: '2026-11-02T00:00:00Z' }));
  const progress = vi.fn();
  const result = await prepareBundle({ readFile }, 'p', ['a.py', 'b.py', 'c.py'], true, 'zip', progress);
  expect(result.files.map((file) => file.source)).toEqual(['pc', 'cache', 'cache']);
  expect(result.source).toBe('cache');
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenLastCalledWith(3);
});

test('ZIP 不受文本包 20 万字符限制；二进制与缺缓存分别说明', async () => {
  const readFile = vi.fn(async (_id: string, path: string) => {
    if (path === 'logo.png') throw new PocketCodeError(415, 'UNSUPPORTED_FORMAT', '二进制文件');
    return data(path, 'x'.repeat(300_000));
  });
  const zip = await prepareBundle({ readFile }, 'p', ['large.py', 'logo.png'], true, 'zip');
  expect(zip.files).toHaveLength(1);
  expect(zip.skipped).toEqual([{ path: 'logo.png', reason: '二进制文件' }]);
  h.load.mockImplementation(async (_id, path) => path === 'small.py' ? { data: data(path), fetchedAt: '' } : null);
  const cached = await prepareBundle(null, 'p', ['missing.py', 'small.py'], false, 'zip');
  expect(cached.skipped[0]).toMatchObject({ path: 'missing.py', reason: '没有本地缓存' });
});

test('文本与 ZIP 上限独立，超限不截断文件正文，并继续收集能容纳的文件', async () => {
  const readFile = vi.fn(async (_id: string, path: string) => data(path, path === 'huge' ? '中'.repeat(4_000_000) : 'OK'));
  const zip = await prepareBundle({ readFile }, 'p', ['huge', 'small'], true, 'zip');
  expect(zip.files.map((file) => file.path)).toEqual(['small']);
  expect(zip.skipped[0].reason).toContain('10 MiB');
  const text = await prepareBundle({ readFile }, 'p', ['huge', 'small'], true, 'text');
  expect(text.skipped[0].reason).toContain('20 万');
});

test('撤销/路径越界不能降级成缓存分享，停止后不继续读取', async () => {
  const readFile = vi.fn(async () => { throw new PocketCodeError(401, 'UNAUTHORIZED', '授权已撤销'); });
  await expect(prepareBundle({ readFile }, 'p', ['a', 'b'], true, 'zip')).rejects.toThrow('撤销');
  expect(h.load).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  readFile.mockClear();
  await expect(prepareBundle({ readFile }, 'p', ['a'], true, 'zip', undefined, controller.signal)).rejects.toThrow('取消');
  expect(readFile).not.toHaveBeenCalled();
});

test('超过文件数量限制时不发请求', async () => {
  const readFile = vi.fn();
  await expect(prepareBundle({ readFile }, 'p', Array.from({ length: 1001 }, (_, i) => `${i}`), true, 'zip')).rejects.toThrow('1000');
  expect(readFile).not.toHaveBeenCalled();
});
