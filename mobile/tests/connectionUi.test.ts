import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// 与 fileScreen.test 相同的组件 hook 驱动方式：运行真实组件逻辑，替换原生与 I/O。
// 不模拟 Android WebView，也不作为真机验收。
const h = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false,
  connection: {} as any,
  loadProjects: vi.fn(), loadManifest: vi.fn(),
  cacheProject: vi.fn(),
}));
vi.mock('react', async (original) => {
  const actual = await original<any>();
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn: () => any, deps: any[]) => {
    const i = h.cursor++;
    if (!h.slots[i] || !same(h.slots[i].deps, deps)) h.slots[i] = { deps, value: fn() };
    return h.slots[i].value;
  };
  return {
    ...actual,
    useState(initial: any) {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[i], (next: any) => {
        const value = typeof next === 'function' ? next(h.slots[i]) : next;
        if (!Object.is(value, h.slots[i])) { h.slots[i] = value; h.dirty = true; }
      }];
    },
    useRef(initial: any) {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = { current: initial };
      return h.slots[i];
    },
    useMemo: memo,
    useCallback: (fn: any, deps: any[]) => memo(() => fn, deps),
    useEffect(fn: () => any, deps: any[]) {
      const i = h.cursor++;
      if (!h.slots[i] || !same(h.slots[i].deps, deps)) {
        const old = h.slots[i];
        h.slots[i] = { deps };
        h.effects.push(() => { old?.cleanup?.(); h.slots[i].cleanup = fn(); });
      }
    },
  };
});
vi.mock('../src/app/useConnection', () => ({ useConnection: () => h.connection }));
vi.mock('../src/features/explorer/cacheProject', () => ({ cacheProject: h.cacheProject }));
vi.mock('../src/app/scrollMemory', () => ({ restoreWindowScroll: vi.fn(), saveWindowScroll: vi.fn() }));
vi.mock('../src/storage/cacheStore', () => ({
  loadCachedProjects: h.loadProjects, loadCachedManifest: h.loadManifest,
  saveCachedProjects: vi.fn(), saveCachedManifest: vi.fn(),
  loadCachedFile: vi.fn(), saveCachedFile: vi.fn(),
}));

import { App } from '../src/app/App';
import type { Connection } from '../src/app/useConnection';
import type { ProbeResult } from '../src/api/probe';
import { PocketCodeClient, PocketCodeError } from '../src/api/client';
import { ConnectionScreen } from '../src/features/settings/ConnectionScreen';
import { ProjectListScreen } from '../src/features/projects/ProjectListScreen';
import { ExplorerScreen } from '../src/features/explorer/ExplorerScreen';
import { ProjectCacheButton } from '../src/features/explorer/ProjectCacheButton';

let component: () => any;
let tree: any;
let client: any;
const project = { id: 'p1', name: 'Demo', revision: 1 };
const entries = [
  { trash_id: 't1', project_id: 'p1', original_path: 'old.py', kind: 'file', deleted_at: '2026-10-26T00:00:00Z' },
  { trash_id: 't2', project_id: 'p2', original_path: 'folder', kind: 'dir', deleted_at: '2026-10-26T00:00:00Z' },
];
const render = () => {
  h.cursor = 0; h.dirty = false;
  tree = component();
  h.effects.splice(0).forEach((effect) => effect());
};
const drain = async () => {
  for (let i = 0; i < 30; i++) { await Promise.resolve(); if (h.dirty) render(); }
};
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const button = (label: string) => {
  const found = nodes(tree).find((n) => n.type === 'button' && (n.props['aria-label'] ?? text(n).trim()) === label);
  if (!found) throw new Error('Missing button ' + label);
  return found.props;
};
const openTrash = async () => {
  component = () => ConnectionScreen({ client, connection: h.connection });
  render(); await drain();
};
const click = async (label: string) => { button(label).onClick(); await drain(); };

beforeEach(() => {
  h.slots = []; h.cursor = 0; h.effects = []; h.dirty = false;
  h.connection = {
    pairing: { baseUrl: 'https://test', deviceToken: 'token', fingerprint: 'sha256:' + 'a'.repeat(64), serverName: 'PC' },
    status: { state: 'online', latencyMs: 2 }, lastProbe: null, busy: false, scanning: false,
    refresh: vi.fn(), pairFromQr: vi.fn(), unpair: vi.fn(),
  } satisfies Connection;
  h.loadProjects.mockResolvedValue({ fetchedAt: '2026-10-26T00:00:00Z', projects: [project] });
  h.loadManifest.mockResolvedValue({ fetchedAt: '2026-10-26T00:00:00Z', root: { children: [] } });
  client = {
    listTrash: vi.fn().mockResolvedValue({ items: entries }),
    deleteTrashEntry: vi.fn().mockResolvedValue(undefined),
    clearTrash: vi.fn().mockResolvedValue(undefined),
    restoreTrash: vi.fn().mockResolvedValue({ restored_path: 'old.py' }),
    listProjects: vi.fn(() => new Promise(() => {})),
    getManifest: vi.fn(() => new Promise(() => {})),
  } as unknown as PocketCodeClient;
  vi.stubGlobal('window', {
    confirm: vi.fn(() => true), scrollTo: vi.fn(), scrollY: 0,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  h.slots.forEach((slot) => slot?.cleanup?.());
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

test('定时探测返回相同配对值时复用 client，凭据变化时才更换', () => {
  component = App; render();
  const pageClient = () => nodes(tree).find((n) => n.type === ProjectListScreen).props.client;
  const first = pageClient();
  for (let i = 0; i < 3; i++) {
    h.connection = { ...h.connection, pairing: { ...h.connection.pairing }, busy: i % 2 === 0 };
    render();
    expect(pageClient()).toBe(first);
  }
  h.connection.pairing = { ...h.connection.pairing, deviceToken: 'changed-token' };
  render(); expect(pageClient()).not.toBe(first);
});

test.each(['projects', 'explorer'])('%s 在线后台读缓存时不显示离线提示，断线仍提示', async (page) => {
  let online = true;
  component = () => page === 'projects'
    ? ProjectListScreen({ client, paired: true, online, onOpenProject() {} })
    : ExplorerScreen({ client, project, online, revoked: false, onBack() {}, onOpenFile() {}, onOpenSearch() {}, onOpenGit() {}, onOpenShare() {} });
  render(); await drain();
  expect(text(tree)).not.toContain('离线可读');
  expect(text(tree)).not.toContain('目录来自本地缓存');
  online = false; render(); await drain();
  expect(text(tree)).toContain(page === 'projects' ? '离线可读' : '目录来自本地缓存');
});

test.each(['projects', 'explorer'])('%s 真实请求失败时仍展示缓存提示', async (page) => {
  client.listProjects.mockRejectedValue(new PocketCodeError(0, 'OFFLINE', '断线'));
  client.getManifest.mockRejectedValue(new PocketCodeError(0, 'OFFLINE', '断线'));
  component = () => page === 'projects'
    ? ProjectListScreen({ client, paired: true, online: true, onOpenProject() {} })
    : ExplorerScreen({ client, project, online: true, revoked: false, onBack() {}, onOpenFile() {}, onOpenSearch() {}, onOpenGit() {}, onOpenShare() {} });
  render(); await drain();
  expect(text(tree)).toContain(page === 'projects' ? '离线可读' : '目录来自本地缓存');
});

test.each(['projects', 'explorer'])('%s 保留定时后台更新，更新期间不闪离线提示', async (page) => {
  let lastProbe: ProbeResult = { kind: 'online', latencyMs: 1, service: 'pocketcode', protocolVersion: '1.0' };
  const response = page === 'projects' ? { projects: [project] } : { root: { children: [] } };
  const request = page === 'projects' ? client.listProjects : client.getManifest;
  request.mockResolvedValueOnce(response);
  component = () => page === 'projects'
    ? ProjectListScreen({ client, paired: true, online: true, lastProbe, onOpenProject() {} })
    : ExplorerScreen({ client, project, online: true, lastProbe, revoked: false, onBack() {}, onOpenFile() {}, onOpenSearch() {}, onOpenGit() {}, onOpenShare() {} });
  render(); await drain();
  expect(request).toHaveBeenCalledTimes(1);
  lastProbe = { kind: 'online', latencyMs: 2, service: 'pocketcode', protocolVersion: '1.0' };
  render(); await drain();
  expect(request).toHaveBeenCalledTimes(2);
  expect(text(tree)).not.toContain('离线可读');
  expect(text(tree)).not.toContain('目录来自本地缓存');
});

test('永久删除取消后不发送请求；确认后只移除选中的目录', async () => {
  await openTrash();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await click('永久删除 folder');
  expect(client.deleteTrashEntry).not.toHaveBeenCalled();
  expect(text(tree)).toContain('folder');
  await click('永久删除 folder');
  expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('文件夹及其全部内容'));
  expect(client.deleteTrashEntry).toHaveBeenCalledWith('t2');
  expect(nodes(tree).filter((n) => n.type === 'li')).toHaveLength(1);
  expect(button('永久删除 old.py').disabled).toBe(false);
  expect(text(tree)).toContain('已永久删除 folder');
  expect(client.listTrash).toHaveBeenCalledTimes(1);
});

test('清空回收区明确包含所有项目，取消不删除，成功后显示空列表', async () => {
  await openTrash();
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  await click('清空回收区');
  expect(client.clearTrash).not.toHaveBeenCalled();
  await click('清空回收区');
  expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('所有项目'));
  expect(client.clearTrash).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain('回收区是空的');
  expect(button('清空回收区').disabled).toBe(true);
});

test('删除处理中禁用其他操作，失败保留条目并提示原因', async () => {
  let reject!: (error: Error) => void;
  client.deleteTrashEntry.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await openTrash(); await click('永久删除 old.py');
  expect(button('永久删除 folder').disabled).toBe(true);
  expect(button('清空回收区').disabled).toBe(true);
  reject(new PocketCodeError(500, 'IO_ERROR', '文件被占用'));
  await drain();
  expect(nodes(tree).filter((n) => n.type === 'li')).toHaveLength(2);
  expect(text(tree)).toContain('文件被占用');
  expect(button('永久删除 old.py').disabled).toBe(false);
});

test('清空失败保留列表，离线禁止删除和清空；重新连接加载回收区', async () => {
  await openTrash();
  client.clearTrash.mockRejectedValue(new Error('network'));
  await click('清空回收区');
  expect(nodes(tree).filter((n) => n.type === 'li')).toHaveLength(2);
  expect(text(tree)).toContain('清空失败');
  h.connection.status = { state: 'offline' }; render(); await drain();
  expect(button('永久删除 old.py').disabled).toBe(true);
  await click('永久删除 old.py');
  expect(client.deleteTrashEntry).not.toHaveBeenCalled();
  expect(button('清空回收区').disabled).toBe(true);
  await click('清空回收区');
  expect(client.clearTrash).toHaveBeenCalledTimes(1);
  h.connection.status = { state: 'online', latencyMs: 1 }; render(); await drain();
  expect(client.listTrash).toHaveBeenCalledTimes(2);
});

test('恢复成功直接更新列表；定时探测不冲掉成功提示', async () => {
  await openTrash();
  const restore = nodes(tree).find((n) => n.type === 'button' && text(n) === '恢复');
  restore.props.onClick(); await drain();
  expect(client.restoreTrash).toHaveBeenCalledWith('t1');
  expect(nodes(tree).filter((n) => n.type === 'li')).toHaveLength(1);
  h.connection = { ...h.connection, pairing: { ...h.connection.pairing } }; render(); await drain();
  expect(text(tree)).toContain('已恢复到 old.py');
  expect(client.listTrash).toHaveBeenCalledTimes(1);
});

test('项目缓存按钮传入当前项目，忙碌时防重复，停止会取消任务并显示结果', async () => {
  let finish!: (value: any) => void;
  h.cacheProject.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  component = () => ProjectCacheButton({ client, projectId: 'p1', online: true, revoked: false });
  render(); await drain();
  await click('一键缓存项目');
  expect(h.cacheProject).toHaveBeenCalledTimes(1);
  const [passedClient, id, options] = h.cacheProject.mock.calls[0];
  expect(passedClient).toBe(client);
  expect(id).toBe('p1');
  expect(button('正在缓存项目…').disabled).toBe(true);
  await click('正在缓存项目…');
  expect(h.cacheProject).toHaveBeenCalledTimes(1);
  const result = { total: 4, completed: 2, saved: 1, reused: 1, skipped: 0, failed: 0, bytes: 200, truncated: false, stopped: null, issues: [] };
  options.onProgress(result); await drain();
  expect(text(tree)).toContain('已处理 2 / 4');
  await click('停止');
  expect(options.signal.aborted).toBe(true);
  expect(text(tree)).toContain('正在停止');
  finish({ ...result, stopped: '已停止' }); await drain();
  expect(text(tree)).toContain('缓存已停止');
  expect(button('一键缓存项目').disabled).toBe(false);
});

test('项目缓存断线或卸载会取消任务，重新连接可再缓存；离线禁止启动', async () => {
  let online = false;
  h.cacheProject.mockImplementation(() => new Promise(() => {}));
  component = () => ProjectCacheButton({ client, projectId: 'p1', online, revoked: false });
  render(); await drain();
  expect(button('一键缓存项目').disabled).toBe(true);
  await click('一键缓存项目');
  expect(h.cacheProject).not.toHaveBeenCalled();
  online = true; render(); await drain();
  await click('一键缓存项目');
  const signal = h.cacheProject.mock.calls[0][2].signal;
  online = false; render(); await drain();
  expect(signal.aborted).toBe(true);
});
