import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllDrafts,
  clearDrafts,
  listAllDrafts,
  loadDrafts,
  newDraftId,
  removeDraft,
  renameDraft,
  setActiveDraft,
  upsertDraft,
  type FileDraft,
} from '../src/storage/draftStore';
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

let storage: KVStorage;

beforeEach(() => {
  storage = fakeStorage();
});

function draft(name: string, content: string, baseVersion = 'sha256:' + 'a'.repeat(64)): FileDraft {
  return {
    id: newDraftId(),
    name,
    path: 'agents/react_agent.py',
    projectId: 'p1',
    content,
    baseVersion,
    savedAt: '2026-10-25T00:00:00Z',
  };
}

describe('draftStore（草稿箱，原生磁盘 KV）', () => {
  it('无草稿时返回空', async () => {
    expect(await loadDrafts('p1', 'a.py', storage)).toEqual({ activeId: null, drafts: [] });
  });

  it('upsert 写入并设为活动草稿；同 id 更新不重复', async () => {
    const first = draft('自动草稿', 'v1');
    await upsertDraft('p1', 'a.py', first, storage);
    const updated = { ...first, content: 'v2' };
    const stored = await upsertDraft('p1', 'a.py', updated, storage);
    expect(stored.drafts).toHaveLength(1);
    expect(stored.drafts[0].content).toBe('v2');
    expect(stored.activeId).toBe(first.id);
  });

  it('多份草稿共存，活动草稿可切换，删除活动草稿顺延', async () => {
    const a = draft('自动草稿', 'v1');
    const b = draft('实验 A', 'v2');
    await upsertDraft('p1', 'a.py', a, storage);
    await upsertDraft('p1', 'a.py', b, storage);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(2);

    const switched = await setActiveDraft('p1', 'a.py', a.id, storage);
    expect(switched.activeId).toBe(a.id);

    const afterRemove = await removeDraft('p1', 'a.py', a.id, storage);
    expect(afterRemove.drafts).toHaveLength(1);
    expect(afterRemove.activeId).toBe(b.id);
  });

  it('草稿按 项目+路径 隔离', async () => {
    const d = draft('x', 'x');
    await upsertDraft('p1', 'a.py', d, storage);
    expect((await loadDrafts('p2', 'a.py', storage)).drafts).toHaveLength(0);
    expect((await loadDrafts('p1', 'b.py', storage)).drafts).toHaveLength(0);
  });

  it('损坏数据明确报错，更新不得覆盖原始内容', async () => {
    await storage.set('pc.draft.p1.a.py', '{broken');
    await expect(loadDrafts('p1', 'a.py', storage)).rejects.toThrow('原数据未改动');
    await expect(upsertDraft('p1', 'a.py', draft('new', 'new'), storage)).rejects.toThrow();
    expect(await storage.get('pc.draft.p1.a.py')).toBe('{broken');
    await storage.set('pc.draft.p1.a.py', '{"drafts": [{"id": "x"}]}');
    await expect(loadDrafts('p1', 'a.py', storage)).rejects.toThrow('格式损坏');
  });

  it('clearDrafts 清空（保存成功后调用）', async () => {
    await upsertDraft('p1', 'a.py', draft('x', 'x'), storage);
    await clearDrafts('p1', 'a.py', storage);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(0);
  });

  it('renameDraft 只改名字，内容/顺序/活动态不变（S4a）', async () => {
    const a = draft('旧名字', '内容 A');
    const b = draft('实验 A', '内容 B');
    await upsertDraft('p1', 'a.py', a, storage);
    await upsertDraft('p1', 'a.py', b, storage);
    await setActiveDraft('p1', 'a.py', a.id, storage);

    const renamed = await renameDraft('p1', 'a.py', a.id, '  新名字  ', storage);
    expect(renamed?.activeId).toBe(a.id);
    // upsert 最新在前：b 后写入，所以 b 排前面；重命名不改变顺序
    expect(renamed?.drafts.map((d) => d.name)).toEqual(['实验 A', '新名字']);
    expect(renamed?.drafts.find((d) => d.id === a.id)?.content).toBe('内容 A');
  });

  it('renameDraft：不存在/空白名字时安全返回', async () => {
    const a = draft('名字', '内容');
    await upsertDraft('p1', 'a.py', a, storage);
    expect(await renameDraft('p1', 'a.py', 'missing', 'x', storage)).toBeNull();
    const same = await renameDraft('p1', 'a.py', a.id, '   ', storage);
    expect(same?.drafts[0].name).toBe('名字');
  });

  it('listAllDrafts 跨文件/跨项目列出并按时间新→旧（S4a2 草稿箱）', async () => {
    const a = { ...draft('旧草稿', 'A'), savedAt: '2026-10-25T08:00:00Z' };
    const b = { ...draft('新草稿', 'B'), savedAt: '2026-10-25T09:00:00Z' };
    await upsertDraft('p1', 'a.py', a, storage);
    await upsertDraft('p2', 'sub/b.js', b, storage);

    const items = await listAllDrafts(storage);
    expect(items).toHaveLength(2);
    expect(items[0].draft.name).toBe('新草稿');
    expect(items[0].projectId).toBe('p2');
    expect(items[0].path).toBe('sub/b.js');
    expect(items[1].path).toBe('a.py');
  });

  it('listAllDrafts：中文路径可从键名还原', async () => {
    await upsertDraft('p1', 'docs/笔记.md', draft('灵感', 'x'), storage);
    const items = await listAllDrafts(storage);
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe('docs/笔记.md');
  });

  it('clearAllDrafts 清空所有文件的草稿', async () => {
    await upsertDraft('p1', 'a.py', draft('x', 'x'), storage);
    await upsertDraft('p2', 'b.py', draft('y', 'y'), storage);
    expect(await clearAllDrafts(storage)).toBe(2);
    expect(await listAllDrafts(storage)).toHaveLength(0);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(0);
  });

  it('一次读取异常后不写回空列表；恢复后可继续写入并保留旧草稿', async () => {
    const old = draft('old', 'KEEP');
    await upsertDraft('p1', 'a.py', old, storage);
    const originalGet = storage.get;
    storage.get = async () => { throw new Error('temporary read error'); };
    await expect(upsertDraft('p1', 'a.py', draft('new', 'NEW'), storage)).rejects.toThrow('无法读取');
    storage.get = originalGet;
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toEqual([expect.objectContaining({ id: old.id, content: 'KEEP' })]);
    await upsertDraft('p1', 'a.py', draft('new', 'NEW'), storage);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(2);
  });

  it('跨页面并发读改写不会丢失多份草稿，失败后队列仍可继续', async () => {
    const a = draft('A', 'A'), b = draft('B', 'B');
    await Promise.all([upsertDraft('p1', 'a.py', a, storage), upsertDraft('p1', 'a.py', b, storage)]);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(2);
    await Promise.all([renameDraft('p1', 'a.py', a.id, 'RENAMED', storage), removeDraft('p1', 'a.py', b.id, storage)]);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts.map((d) => d.name)).toEqual(['RENAMED']);
  });

  it('清空与在途写入按调用顺序执行，枚举失败不冒充空列表', async () => {
    const pending = upsertDraft('p1', 'a.py', draft('A', 'A'), storage);
    const clear = clearAllDrafts(storage);
    await pending; await clear;
    expect(await listAllDrafts(storage)).toEqual([]);
    storage.keys = async () => { throw new Error('read error'); };
    await expect(listAllDrafts(storage)).rejects.toThrow('无法读取草稿箱');
    await expect(clearAllDrafts(storage)).rejects.toThrow('read error');
  });

  it('旧草稿兼容且新记录的编码换行信息在更新后保留', async () => {
    const a = { ...draft('A', 'A'), encoding: 'utf-8-bom' as const, newline: 'CRLF' as const };
    await upsertDraft('p1', 'a.py', a, storage);
    const { encoding: _encoding, newline: _newline, ...withoutMetadata } = { ...a, content: 'B' };
    await upsertDraft('p1', 'a.py', withoutMetadata, storage);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts[0]).toMatchObject({ content: 'B', encoding: 'utf-8-bom', newline: 'CRLF' });
  });

  it('草稿箱可报告损坏文件，同时展示其他可读草稿；损坏原文不变', async () => {
    await upsertDraft('p1', 'good.py', draft('good', 'KEEP'), storage);
    await storage.set('pc.draft.p1.bad.py', '{broken');
    const errors: string[] = [];
    const items = await listAllDrafts(storage, (message) => errors.push(message));
    expect(items).toHaveLength(1);
    expect(items[0].draft.content).toBe('KEEP');
    expect(errors[0]).toContain('bad.py');
    expect(await storage.get('pc.draft.p1.bad.py')).toBe('{broken');
  });

  it('同一记录部分损坏时，不通过过滤无效项来覆盖剩余原文', async () => {
    const raw = JSON.stringify({ activeId: 'bad', drafts: [draft('valid', 'KEEP'), { id: 'bad', content: 'RECOVER ME' }] });
    await storage.set('pc.draft.p1.a.py', raw);
    await expect(upsertDraft('p1', 'a.py', draft('new', 'NEW'), storage)).rejects.toThrow();
    await expect(removeDraft('p1', 'a.py', 'bad', storage)).rejects.toThrow();
    expect(await storage.get('pc.draft.p1.a.py')).toBe(raw);
  });
});
