import { beforeEach, describe, expect, it } from 'vitest';

import { searchCachedFiles } from '../src/storage/cachedSearch';
import { saveCachedFile } from '../src/storage/cacheStore';
import type { KVStorage } from '../src/native';
import type { FileContentResponse } from '../src/api/types';

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

let storage: KVStorage;

beforeEach(() => {
  storage = fakeStorage();
});

function fileOf(path: string, content: string): FileContentResponse {
  return {
    project_id: 'p1',
    path,
    content,
    encoding: 'utf-8',
    newline: 'LF',
    version: `sha256:${'a'.repeat(64)}` as const,
    size: content.length,
    mtime: '2026-10-25T00:00:00Z',
    read_only: false,
  };
}

describe('cachedSearch（离线缓存全文搜索，S4b）', () => {
  it('按行匹配缓存文件，大小写不敏感，行号 1-based', async () => {
    await saveCachedFile('p1', fileOf('a.py', 'from serpapi import X\nplain line\nSERPAPI_KEY = 1\n'), storage);
    await saveCachedFile('p1', fileOf('docs/notes.md', 'SerpApi 网页搜索\n'), storage);

    const result = await searchCachedFiles('p1', '  SerpApi  ', storage);
    expect(result.query).toBe('SerpApi');
    expect(result.totalMatches).toBe(3);
    expect(result.truncated).toBe(false);
    const py = result.matches.find((m) => m.path === 'a.py');
    expect(py?.lines).toEqual([
      { line: 1, text: 'from serpapi import X' },
      { line: 3, text: 'SERPAPI_KEY = 1' },
    ]);
  });

  it('只搜指定项目；无命中返回空', async () => {
    await saveCachedFile('p1', fileOf('a.py', 'needle here\n'), storage);
    await saveCachedFile('p2', fileOf('b.py', 'needle there\n'), storage);

    const other = await searchCachedFiles('p2', 'needle', storage);
    expect(other.matches).toHaveLength(1);
    expect(other.matches[0].path).toBe('b.py');

    const none = await searchCachedFiles('p1', '不存在xyz', storage);
    expect(none.matches).toEqual([]) ?? expect(none.totalMatches).toBe(0);
    expect(none.totalMatches).toBe(0);
  });

  it('报告缓存同步时间（取最新 fetchedAt）；损坏条目跳过', async () => {
    await saveCachedFile('p1', fileOf('a.py', 'needle\n'), storage);
    await storage.set('pc.cache.file.p1.broken.py', '{broken json');
    // 直接写一份旧条目验证时间戳
    await storage.set(
      'pc.cache.file.p1.old.py',
      JSON.stringify({ fetchedAt: '2026-10-24T00:00:00Z', data: { content: 'needle\n' } }),
    );

    const result = await searchCachedFiles('p1', 'needle', storage);
    // saveCachedFile 刚写入的是当前时间，一定晚于 2026-10-24
    expect(result.cachedAt).not.toBe('2026-10-24T00:00:00Z');
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('空关键词直接返回空结果', async () => {
    await saveCachedFile('p1', fileOf('a.py', 'anything\n'), storage);
    const result = await searchCachedFiles('p1', '   ', storage);
    expect(result.totalMatches).toBe(0);
    expect(result.matches).toEqual([]);
  });
});
