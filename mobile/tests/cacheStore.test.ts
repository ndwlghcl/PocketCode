import { beforeEach, describe, expect, it } from 'vitest';

import type { FileContentResponse, ManifestDir } from '../src/api/types';
import type { KVStorage } from '../src/native';
import {
  loadCachedFile,
  loadCachedManifest,
  loadCachedProjects,
  saveCachedFile,
  saveCachedManifest,
  saveCachedProjects,
} from '../src/storage/cacheStore';

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
  };
}

let storage: KVStorage;

beforeEach(() => {
  storage = fakeStorage();
});

describe('cacheStore（项目/目录/文件缓存，原生磁盘 KV）', () => {
  it('项目列表往返', async () => {
    expect(await loadCachedProjects(storage)).toBeNull();
    await saveCachedProjects([{ id: 'p1', name: 'demo', revision: 3 }], storage);
    const cached = await loadCachedProjects(storage);
    expect(cached?.projects[0]).toEqual({ id: 'p1', name: 'demo', revision: 3 });
    expect(cached?.fetchedAt).toBeTruthy();
  });

  it('manifest 往返，按项目隔离', async () => {
    const root: ManifestDir = { type: 'dir', name: '', path: '', children: [] };
    await saveCachedManifest('p1', { revision: 5, root }, storage);
    expect((await loadCachedManifest('p1', storage))?.revision).toBe(5);
    expect(await loadCachedManifest('p2', storage)).toBeNull();
  });

  it('文件内容缓存往返（按项目+路径隔离）', async () => {
    const data: FileContentResponse = {
      project_id: 'p1',
      path: 'agents/react_agent.py',
      content: "print('hello')\n",
      encoding: 'utf-8',
      newline: 'LF',
      version: ('sha256:' + 'd'.repeat(64)) as FileContentResponse['version'],
      size: 15,
      mtime: '2026-10-25T00:00:00Z',
      read_only: false,
    };
    expect(await loadCachedFile('p1', 'agents/react_agent.py', storage)).toBeNull();
    await saveCachedFile('p1', data, storage);
    const cached = await loadCachedFile('p1', 'agents/react_agent.py', storage);
    expect(cached?.data.content).toBe("print('hello')\n");
    expect(cached?.fetchedAt).toBeTruthy();
    expect(await loadCachedFile('p2', 'agents/react_agent.py', storage)).toBeNull();
    expect(await loadCachedFile('p1', 'other.py', storage)).toBeNull();
  });

  it('损坏的缓存返回 null 而不是抛错', async () => {
    await storage.set('pc.cache.projects', '{broken');
    expect(await loadCachedProjects(storage)).toBeNull();
    await storage.set('pc.cache.projects', '"not-an-object"');
    expect(await loadCachedProjects(storage)).toBeNull();
  });
});
