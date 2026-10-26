import { describe, expect, it, vi } from 'vitest';
import type { FileContentResponse, ManifestFile, ManifestNode, ManifestResponse } from '../src/api/types';
import { PocketCodeError } from '../src/api/client';
import type { KVStorage } from '../src/native';
import { loadCachedFile, loadCachedManifest, saveCachedFile } from '../src/storage/cacheStore';
import { cacheProject, type ProjectCacheProgress } from '../src/features/explorer/cacheProject';

const version = ('sha256:' + 'a'.repeat(64)) as FileContentResponse['version'];
function file(path: string, size = 10): ManifestFile {
  return { type: 'file', name: path.split('/').pop()!, path, size, mtime: '2026-10-26T00:00:00Z', version, read_only: false };
}
function content(path: string, text = 'print(1)'): FileContentResponse {
  return { project_id: 'p', path, content: text, encoding: 'utf-8', newline: 'LF', version, size: text.length, mtime: '2026-10-26T00:00:00Z', read_only: false };
}
function fixture(children: ManifestNode[]) {
  const kv = new Map<string, string>();
  const storage: KVStorage = {
    get: vi.fn(async (key) => kv.get(key) ?? null),
    set: vi.fn(async (key, value) => { kv.set(key, value); }),
    remove: vi.fn(async (key) => { kv.delete(key); }),
    keys: vi.fn(async (prefix) => [...kv.keys()].filter((key) => key.startsWith(prefix))),
  };
  const manifest: ManifestResponse = { project_id: 'p', revision: 2, generated_at: '2026-10-26T00:00:00Z', truncated: false, root: { type: 'dir', path: '', name: '', children } };
  const client = {
    getManifest: vi.fn(async () => manifest),
    readFile: vi.fn(async (_id: string, path: string) => content(path)),
  };
  return { client, storage, kv, manifest };
}

describe('一键缓存项目', () => {
  it('缓存未展开目录的全部文件、空目录元数据，供现有离线读取使用；不动草稿', async () => {
    const { client, storage, kv } = fixture([file('a.py'), { type: 'dir', name: 'pkg', path: 'pkg', children: [file('pkg/b.py')] }, { type: 'dir', name: 'empty', path: 'empty', children: [] }]);
    kv.set('pc.draft.p.a.py', 'my draft');
    const updates: ProjectCacheProgress[] = [];
    const result = await cacheProject(client, 'p', { storage, onProgress: (value) => updates.push(value) });
    expect(result).toMatchObject({ total: 2, completed: 2, saved: 2, failed: 0, stopped: null });
    expect((await loadCachedFile('p', 'pkg/b.py', storage))?.data.content).toBe('print(1)');
    expect((await loadCachedManifest('p', storage))?.root.children).toHaveLength(3);
    expect(kv.get('pc.draft.p.a.py')).toBe('my draft');
    expect(updates[0].saved).toBe(0);
    expect(updates.at(-1)?.saved).toBe(2);
    expect((storage.set as any).mock.calls.every(([key]: [string]) => key.startsWith('pc.cache.'))).toBe(true);
  });

  it('相同版本复用本地缓存；变化的版本重新下载，可重复点击补齐', async () => {
    const { client, storage } = fixture([file('a.py'), file('b.py')]);
    await saveCachedFile('p', content('a.py'), storage);
    await saveCachedFile('p', { ...content('b.py'), version: 'sha256:old' }, storage);
    expect(await cacheProject(client, 'p', { storage })).toMatchObject({ saved: 1, reused: 1 });
    expect(client.readFile).toHaveBeenCalledTimes(1);
    expect(client.readFile).toHaveBeenCalledWith('p', 'b.py');
    expect(await cacheProject(client, 'p', { storage })).toMatchObject({ saved: 0, reused: 2 });
    expect(client.readFile).toHaveBeenCalledTimes(1);
  });

  it('依赖、敏感配置、大文件不发正文请求，二进制返回后标记跳过', async () => {
    const { client, storage } = fixture([
      file('.env.local'), file('credentials.json'), file('id_rsa'), file('tls.key'), file('huge.txt', 1_000_001),
      { type: 'dir', name: 'node_modules', path: 'node_modules', children: [file('node_modules/a.js')] },
      file('logo.png'), file('a.py'),
    ]);
    client.readFile.mockImplementation(async (_id, path) => {
      if (path === 'logo.png') throw new PocketCodeError(415, 'UNSUPPORTED_FORMAT', '二进制文件');
      return content(path);
    });
    const result = await cacheProject(client, 'p', { storage });
    expect(result).toMatchObject({ total: 8, completed: 8, saved: 1, skipped: 7, failed: 0 });
    expect(client.readFile).toHaveBeenCalledTimes(2);
    expect(result.issues.map((item) => item.path)).toContain('node_modules/a.js');
  });

  it('断线时停止队列，成功的部分保留；并发最多三个请求', async () => {
    const { client, storage } = fixture(Array.from({ length: 20 }, (_, i) => file(`${i}.py`)));
    let inFlight = 0;
    let peak = 0;
    client.readFile.mockImplementation(async (_id, path) => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      if (path === '1.py') throw new PocketCodeError(0, 'OFFLINE', '电脑已断开');
      return content(path);
    });
    const result = await cacheProject(client, 'p', { storage });
    expect(peak).toBeLessThanOrEqual(3);
    expect(client.readFile.mock.calls.length).toBeLessThan(20);
    expect(result.stopped).toBe('电脑已断开');
    expect(result.failed).toBe(1);
    expect((await loadCachedManifest('p', storage))?.revision).toBe(2);
  });

  it('取消后不再写入在途正文，已保存文件保留；未启动的取消不请求', async () => {
    const { client, storage } = fixture(Array.from({ length: 10 }, (_, i) => file(`${i}.py`)));
    const controller = new AbortController();
    client.readFile.mockImplementation(async (_id, path) => { controller.abort(); return content(path); });
    const result = await cacheProject(client, 'p', { storage, signal: controller.signal });
    expect(result.saved).toBe(0);
    expect(result.stopped).toContain('已停止');
    expect(await loadCachedFile('p', '0.py', storage)).toBeNull();
    client.getManifest.mockClear();
    await cacheProject(client, 'p', { storage, signal: controller.signal });
    expect(client.getManifest).not.toHaveBeenCalled();
  });

  it('单文件读取失败继续其他文件，目录截断明确反馈', async () => {
    const { client, storage, manifest } = fixture([file('gone.py'), file('a.py')]);
    manifest.truncated = true;
    client.readFile.mockImplementation(async (_id, path) => {
      if (path === 'gone.py') throw new PocketCodeError(404, 'NOT_FOUND', '文件已移除');
      return content(path);
    });
    const result = await cacheProject(client, 'p', { storage });
    expect(result).toMatchObject({ saved: 1, failed: 1, truncated: true, stopped: null });
    expect(result.issues[0]).toEqual({ path: 'gone.py', reason: '文件已移除' });
  });

  it('目录或正文写入失败不谎报成功，并停止后续队列', async () => {
    const { client, storage } = fixture(Array.from({ length: 12 }, (_, i) => file(`${i}.py`)));
    vi.mocked(storage.set).mockRejectedValueOnce(new Error('disk full'));
    await expect(cacheProject(client, 'p', { storage })).rejects.toThrow('目录缓存写入失败');
    expect(client.readFile).not.toHaveBeenCalled();
    vi.mocked(storage.set).mockImplementation(async (key) => { if (key.startsWith('pc.cache.file.')) throw new Error('disk full'); });
    const result = await cacheProject(client, 'p', { storage });
    expect(result.saved).toBe(0);
    expect(result.stopped).toContain('写入失败');
    expect(client.readFile.mock.calls.length).toBeLessThan(12);
  });

  it('超过总容量时仍保存额度内内容并说明未缓存原因', async () => {
    const { client, storage } = fixture(Array.from({ length: 54 }, (_, i) => file(`${i}.txt`, 1_000_000)));
    client.readFile.mockImplementation(async (_id, path) => content(path, 'a'.repeat(1_000_000)));
    const result = await cacheProject(client, 'p', { storage });
    expect(result.bytes).toBeLessThanOrEqual(50 * 1024 * 1024);
    expect(result.saved).toBe(52);
    expect(result.skipped).toBe(2);
    expect(result.issues[0].reason).toContain('50 MiB');
  });

  it('空项目成功缓存目录，不发送文件请求', async () => {
    const { client, storage } = fixture([]);
    expect(await cacheProject(client, 'p', { storage })).toMatchObject({ total: 0, completed: 0, saved: 0, stopped: null });
    expect(client.readFile).not.toHaveBeenCalled();
    expect(await loadCachedManifest('p', storage)).not.toBeNull();
  });

  it('缓存部分文件后停止，保留已落盘内容，重试只补未完成的', async () => {
    const { client, storage } = fixture(Array.from({ length: 12 }, (_, i) => file(`${i}.py`)));
    const controller = new AbortController();
    const result = await cacheProject(client, 'p', { storage, signal: controller.signal, onProgress(value) { if (value.saved >= 1) controller.abort(); } });
    expect(result.saved).toBeGreaterThanOrEqual(1);
    expect(result.saved).toBeLessThan(12);
    const retry = await cacheProject(client, 'p', { storage });
    expect(retry.reused).toBe(result.saved);
    expect(retry.saved + retry.reused).toBe(12);
  });

  it('撤销授权会停止队列，不写入其他在途的正文', async () => {
    const { client, storage } = fixture(Array.from({ length: 12 }, (_, i) => file(`${i}.py`)));
    client.readFile.mockRejectedValue(new PocketCodeError(401, 'UNAUTHORIZED', '授权已撤销'));
    const result = await cacheProject(client, 'p', { storage });
    expect(result.stopped).toBe('授权已撤销');
    expect(result.saved).toBe(0);
    expect(client.readFile.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
