import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearDrafts,
  loadDrafts,
  newDraftId,
  removeDraft,
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

  it('损坏数据按无草稿处理', async () => {
    await storage.set('pc.draft.p1.a.py', '{broken');
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(0);
    await storage.set('pc.draft.p1.a.py', '{"drafts": [{"id": "x"}]}');
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(0);
  });

  it('clearDrafts 清空（保存成功后调用）', async () => {
    await upsertDraft('p1', 'a.py', draft('x', 'x'), storage);
    await clearDrafts('p1', 'a.py', storage);
    expect((await loadDrafts('p1', 'a.py', storage)).drafts).toHaveLength(0);
  });
});
