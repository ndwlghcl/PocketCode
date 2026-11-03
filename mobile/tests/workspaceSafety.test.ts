import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import type { KVStorage } from '../src/native';
import type { FileContentResponse, ManifestResponse } from '../src/api/types';
import { exportDraftBackup, restoreDraftBackup, upsertDraft, loadDrafts, relocateFileDrafts } from '../src/storage/draftStore';
import { buildDraftBackup, parseDraftBackup } from '../src/features/drafts/draftBackup';
import { loadMarks, saveMark, loadRecents, rememberFile, locateMark, relocateReading, type ReadingMark } from '../src/storage/readingStore';
import { cacheInventory, clearProjectCache } from '../src/storage/cacheInventory';
import { saveCachedFile, saveCachedManifest } from '../src/storage/cacheStore';
import { CacheJobs } from '../src/features/explorer/cacheJobs';
import { PocketCodeError } from '../src/api/client';

function memory() {
  const map = new Map<string, string>();
  const storage: KVStorage = { get: vi.fn(async (k) => map.get(k) ?? null), set: vi.fn(async (k, v) => { map.set(k, v); }), remove: vi.fn(async (k) => { map.delete(k); }), keys: vi.fn(async (p) => [...map.keys()].filter((k) => k.startsWith(p))) };
  return { map, storage };
}
const version = ('sha256:' + 'a'.repeat(64)) as FileContentResponse['version'];
const draft = { id: 'original', name: 'idea', projectId: 'p', path: 'a.py', content: 'my idea', savedAt: '2026-11-03T00:00:00Z', baseVersion: version, encoding: 'utf-8' as const, newline: 'CRLF' as const };
const mark: ReadingMark = { id: 'm', kind: 'note', line: 2, endLine: 2, quote: 'hello()', note: '为什么这样写', version, savedAt: draft.savedAt };
const file: FileContentResponse = { project_id: 'p', path: 'a.py', content: 'hello()', encoding: 'utf-8', newline: 'LF', version, mtime: draft.savedAt, read_only: false, size: 7 };
const manifest: ManifestResponse = { project_id: 'p', revision: 1, generated_at: draft.savedAt, truncated: false, root: { type: 'dir', path: '', name: '', children: [{ type: 'file', path: 'a.py', name: 'a.py', size: 7, version, mtime: draft.savedAt, read_only: false }] } };

describe('草稿备份与恢复', () => {
  it('备份 ZIP 往返保留内容、来源和编码；恢复只追加，重复恢复跳过', async () => {
    const source = memory(), target = memory();
    await upsertDraft('p', 'a.py', draft, source.storage);
    const archive = await buildDraftBackup(source.storage);
    const backup = parseDraftBackup(archive.bytes);
    expect(backup.drafts[0]).toEqual(draft);
    await upsertDraft('p', 'a.py', { ...draft, content: 'local changed' }, target.storage);
    expect(await restoreDraftBackup(backup, target.storage)).toEqual({ restored: 1, skipped: 0 });
    const stored = await loadDrafts('p', 'a.py', target.storage);
    expect(stored.activeId).toBe('original');
    expect(stored.drafts.map((d) => d.content)).toEqual(['local changed', 'my idea']);
    expect(new Set(stored.drafts.map((d) => d.id)).size).toBe(2);
    expect(await restoreDraftBackup(backup, target.storage)).toEqual({ restored: 0, skipped: 1 });
  });
  it('损坏草稿阻止完整备份，也阻止恢复覆盖；预检全部目标后才写入', async () => {
    const { map, storage } = memory();
    map.set('pc.draft.p.a.py', '{broken');
    await expect(exportDraftBackup(storage)).rejects.toThrow();
    const backup = { format: 'pocketcode-drafts', version: 1, createdAt: draft.savedAt, drafts: [{ ...draft, path: 'b.py' }, draft] };
    await expect(restoreDraftBackup(backup, storage)).rejects.toThrow();
    expect(map.get('pc.draft.p.a.py')).toBe('{broken');
    expect(map.has('pc.draft.p.b.py')).toBe(false);
  });
  it('坏备份、未知版本、路径穿越、过大解压声明都不写入', async () => {
    const { storage } = memory();
    for (const value of [{}, { format: 'pocketcode-drafts', version: 2, createdAt: '', drafts: [] }, { format: 'pocketcode-drafts', version: 1, createdAt: '', drafts: [{ ...draft, path: '../a.py' }] }]) await expect(restoreDraftBackup(value, storage)).rejects.toThrow();
    expect(storage.set).not.toHaveBeenCalled();
    expect(() => parseDraftBackup(zipSync({ 'wrong.json': new Uint8Array([1]) }))).toThrow();
    const bomb = zipSync({ 'PocketCode-草稿备份.json': new Uint8Array(17 * 1024 * 1024) });
    expect(() => parseDraftBackup(bomb)).toThrow();
  });
  it('磁盘写入失败明确报告部分恢复；重试不覆盖或重复已成功版本', async () => {
    const { storage } = memory();
    const backup = { format: 'pocketcode-drafts', version: 1, createdAt: '', drafts: [draft, { ...draft, path: 'b.py' }] };
    const originalSet = storage.set;
    storage.set = async (key, value) => { if (key.endsWith('b.py')) throw new Error('full'); await originalSet(key, value); };
    await expect(restoreDraftBackup(backup, storage)).rejects.toThrow('已恢复 1');
    expect((await loadDrafts('p', 'a.py', storage)).drafts).toHaveLength(1);
    storage.set = originalSet;
    expect(await restoreDraftBackup(backup, storage)).toEqual({ restored: 1, skipped: 1 });
  });
});
describe('阅读记录与旁注', () => {
  it('并发记笔记不丢失；读取损坏数据时阻止覆盖', async () => {
    const { map, storage } = memory();
    await Promise.all([saveMark('p', 'a.py', mark, storage), saveMark('p', 'a.py', { ...mark, id: 'n' }, storage)]);
    expect(await loadMarks('p', 'a.py', storage)).toHaveLength(2);
    const key = 'pc.reading.marks.p.a.py'; map.set(key, 'broken');
    await expect(saveMark('p', 'a.py', mark, storage)).rejects.toThrow();
    expect(map.get(key)).toBe('broken');
  });
  it('只在原文唯一匹配时重定位；重复或删除后不假装定位成功', () => {
    expect(locateMark(mark, 'new\nother\nhello()')).toEqual({ line: 3, matched: true });
    expect(locateMark(mark, 'hello()\nhello()')).toEqual({ line: 2, matched: false });
    expect(locateMark(mark, 'gone')).toEqual({ line: 1, matched: false });
  });
  it('最近文件去重、限 20 条；移动后草稿、旁注、位置跟随且不覆盖目标草稿', async () => {
    const { storage, map } = memory(); const project = { id: 'p', name: 'Demo', revision: 1 };
    await Promise.all(Array.from({ length: 22 }, (_, i) => rememberFile(project, `${i}.py`, storage)));
    expect(await loadRecents(storage)).toHaveLength(20);
    await rememberFile(project, 'a.py', storage);
    await rememberFile(project, 'a.py', storage);
    expect((await loadRecents(storage)).filter((r) => r.path === 'a.py')).toHaveLength(1);
    await saveMark('p', 'a.py', mark, storage);
    map.set('pc.readpos.p.a.py', '{"scrollTop":200}');
    await upsertDraft('p', 'a.py', draft, storage);
    await upsertDraft('p', 'b.py', { ...draft, id: 'destination', path: 'b.py', content: 'destination idea' }, storage);
    await relocateFileDrafts('p', 'a.py', 'b.py', storage);
    await relocateReading('p', 'a.py', 'b.py', storage);
    expect((await loadDrafts('p', 'b.py', storage)).drafts.map((d) => d.content)).toEqual(['destination idea', 'my idea']);
    expect(await loadMarks('p', 'b.py', storage)).toEqual([mark]);
    expect(map.get('pc.readpos.p.b.py')).toBe('{"scrollTop":200}');
    expect((await loadRecents(storage))[0].path).toBe('b.py');
  });
});
describe('缓存管理与跨页面任务', () => {
  it('按真实正文统计，区分当前/旧版；清理不碰其他项目、草稿和笔记', async () => {
    const { storage, map } = memory();
    await saveCachedManifest('p', manifest, storage); await saveCachedFile('p', file, storage);
    await saveCachedFile('p', { ...file, path: 'old.py' }, storage); await saveCachedFile('p2', file, storage);
    await upsertDraft('p', 'a.py', draft, storage); await saveMark('p', 'a.py', mark, storage);
    expect(await cacheInventory('p', storage)).toMatchObject({ files: 2, bytes: 14, directoryFiles: 1, current: 1, stale: 1 });
    await clearProjectCache('p', storage);
    expect((await cacheInventory('p', storage)).files).toBe(0);
    expect((await loadDrafts('p', 'a.py', storage)).drafts).toHaveLength(1);
    expect(await loadMarks('p', 'a.py', storage)).toHaveLength(1);
    expect(map.has('pc.cache.file.p2.a.py')).toBe(true);
  });
  it('退订页面不取消任务；重复启动复用，停止等待请求结束并保留已有文件', async () => {
    const { storage } = memory(); const jobs = new CacheJobs(storage);
    let finish!: (value: FileContentResponse) => void;
    const client = { getManifest: vi.fn(async () => manifest), readFile: vi.fn(() => new Promise<FileContentResponse>((r) => { finish = r; })) };
    const remove = jobs.subscribe(() => {});
    const first = jobs.start('p', client); expect(jobs.start('p', client)).toBe(first);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    remove(); expect(jobs.get('p').busy).toBe(true);
    const stopping = jobs.stop('p'); finish(file); await stopping;
    expect(jobs.get('p')).toMatchObject({ busy: false, progress: { saved: 0, stopped: expect.any(String) } });
    const restored = new CacheJobs(storage); await restored.load('p'); expect(restored.get('p').busy).toBe(false);
  });
  it('失败路径可精确重试，成功项不会重复下载', async () => {
    const { storage } = memory(); const jobs = new CacheJobs(storage);
    const two = { ...manifest, root: { ...manifest.root, children: [...manifest.root.children, { ...manifest.root.children[0], name: 'b.py', path: 'b.py' }] } } as ManifestResponse;
    const client = { getManifest: vi.fn(async () => two), readFile: vi.fn(async (_id: string, path: string) => { if (path === 'b.py') throw new PocketCodeError(500, 'IO_ERROR', 'busy'); return file; }) };
    await jobs.start('p', client); expect(jobs.get('p').progress?.failedPaths).toEqual(['b.py']);
    client.readFile.mockImplementation(async (_id, path) => ({ ...file, path })); client.readFile.mockClear();
    await jobs.start('p', client, new Set(['b.py']));
    expect(client.readFile).toHaveBeenCalledTimes(1); expect(client.readFile).toHaveBeenCalledWith('p', 'b.py');
    expect(jobs.get('p').progress).toMatchObject({ saved: 1, failed: 0 });
  });
  it('清理等待运行任务结束，期间禁止重新启动；不会留下任务晚写入的数据', async () => {
    const { storage, map } = memory(); const jobs = new CacheJobs(storage);
    let finish!: (value: FileContentResponse) => void;
    const client = { getManifest: vi.fn(async () => manifest), readFile: vi.fn(() => new Promise<FileContentResponse>((r) => { finish = r; })) };
    void jobs.start('p', client);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    const clearing = jobs.clear('p');
    await jobs.start('p', client);
    expect(client.getManifest).toHaveBeenCalledTimes(1);
    finish(file); await clearing;
    expect([...map.keys()].filter((key) => key.startsWith('pc.cache.'))).toEqual([]);
    expect(jobs.get('p').clearing).toBeUndefined();
  });
});
