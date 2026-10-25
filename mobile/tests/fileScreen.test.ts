import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Component-only hook harness: native UI, editor, and network are replaced.
// Run the real FileScreen handlers, effects, and draftStore; no Android/E2E claim.
const h = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false,
  kv: new Map<string, string>(), saved: [] as any[],
  failWrites: false,
  readTop: null as number | null,
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
vi.mock('../src/native', () => ({
  diskStorage: {
    get: async (key: string) => h.kv.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (h.failWrites) throw new Error('disk full');
      h.kv.set(key, value);
    },
    remove: async (key: string) => { h.kv.delete(key); },
    keys: async (prefix: string) => [...h.kv.keys()].filter((key) => key.startsWith(prefix)),
  },
}));
vi.mock('../src/storage/cacheStore', () => ({ saveCachedFile: async (_id: any, data: any) => { h.saved.push(data); } }));
vi.mock('../src/features/editor/CodeEditor', () => ({ CodeEditor: 'mock-editor' }));
vi.mock('../src/features/sharing/share', () => ({ shareText: vi.fn() }));
vi.mock('../src/storage/readPositionStore', () => ({
  createPositionSaver: () => ({ flush: async () => {}, push: () => {} }),
  loadReadPosition: async () => h.readTop === null ? null : { scrollTop: h.readTop },
}));
vi.mock('../src/storage/uiPrefs', () => ({ loadWrapPref: async () => true, saveWrapPref: async () => {} }));
vi.mock('../src/app/useConnection', () => ({ useConnection: () => ({
  status: { state: 'online', latencyMs: 1 },
  pairing: { baseUrl: 'https://test', deviceToken: 'token', fingerprint: 'sha256:' + '1'.repeat(64), serverName: 'test' },
}) }));

import { FileScreen } from '../src/features/explorer/FileScreen';
import { loadDrafts, upsertDraft } from '../src/storage/draftStore';
import { App } from '../src/app/App';

let tree: any;
let props: any;
let renderApp = false;
const data = { path: 'a.py', content: 'PC OLD', version: 'sha256:' + '1'.repeat(64), encoding: 'utf-8', newline: 'LF', size: 6, mtime: '2026-10-26T00:00:00Z', read_only: false };
const render = () => {
  h.cursor = 0; h.dirty = false;
  tree = renderApp ? App() : FileScreen(props);
  const effects = h.effects.splice(0);
  effects.forEach((fn) => fn());
};
const drain = async () => {
  for (let i = 0; i < 35; i++) { await Promise.resolve(); if (h.dirty) render(); }
};
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const button = (label: string) => {
  const found = nodes(tree).find((n) => n.type === 'button' && text(n).trim() === label);
  if (!found) throw new Error('Missing button ' + label);
  return found.props;
};
const editor = () => nodes(tree).find((n) => n.type === 'mock-editor').props;
const edit = async () => {
  // Default read view hides its menu until tapped.
  nodes(tree).find((n) => n.props?.className === 'immersive-wrap').props.onClick();
  await drain(); button('✎ 编辑').onClick(); await drain();
};
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = []; h.cursor = 0; h.effects = []; h.dirty = false; h.kv.clear(); h.saved = [];
  h.failWrites = false;
  h.readTop = null;
  renderApp = false;
  props = { client: {}, projectId: 'p', initialData: { ...data }, online: true, revoked: false,
    onBack() {}, registerBackGuard() {} };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test('saving A while typing B keeps B dirty and caches only A', async () => {
  let complete: any;
  let request: any;
  props.client.saveFile = vi.fn(async (_id: string, body: any) => {
    request = body;
    return new Promise((resolve) => { complete = resolve; });
  });
  render(); await drain(); await edit();
  editor().onDocChange('PHONE A'); await drain();
  button('保存').onClick(); await drain();
  expect(request.content).toBe('PHONE A');
  // Editor remains enabled while waiting for the request.
  expect(editor().readOnly).toBe(false);
  editor().onDocChange('PHONE B NOT ON PC'); await drain();
  complete({ version: 'sha256:' + '2'.repeat(64), size: 7, mtime: data.mtime });
  await drain();
  expect(h.saved.at(-1).content).toBe('PHONE A');
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('PHONE B NOT ON PC');
  expect(nodes(tree).some((n) => text(n) === '已同步')).toBe(false);
  expect(button('保存').disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(1000); await drain();
  expect(editor().doc).toBe('PHONE B NOT ON PC');
  expect(editor().readOnly).toBe(false);
});

test('reading refresh preserves the active draft through editing', async () => {
  await upsertDraft('p', 'a.py', { id: 'draft1', name: 'idea', path: 'a.py', projectId: 'p', content: 'MY PRECIOUS IDEA', baseVersion: data.version, savedAt: data.mtime });
  props.client.readFile = async () => ({ ...data, content: 'PC NEW', version: 'sha256:' + '3'.repeat(64) });
  render(); await drain();
  nodes(tree).find((n) => n.props?.className === 'immersive-wrap').props.onClick(); await drain();
  button('刷新').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY PRECIOUS IDEA');
  button('✎ 编辑').onClick(); await drain();
  expect(editor().doc).toBe('MY PRECIOUS IDEA');
  button('✓ 完成').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY PRECIOUS IDEA');
});

test('typing after a successful save cancels the automatic return to read mode', async () => {
  props.client.saveFile = async () => ({ version: 'sha256:' + '2'.repeat(64), size: 7, mtime: data.mtime });
  render(); await drain(); await edit();
  editor().onDocChange('A'); await drain();
  button('保存').onClick(); await drain();
  expect(nodes(tree).some((n) => text(n) === '已同步')).toBe(true);
  editor().onDocChange('B'); await drain();
  await vi.advanceTimersByTimeAsync(1000); await drain();
  expect(editor().doc).toBe('B');
  expect(editor().readOnly).toBe(false);
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('B');
});

test('failed autosave is visible and cannot silently close the edited buffer', async () => {
  render(); await drain(); await edit();
  h.failWrites = true;
  editor().onDocChange('KEEP MY IDEA'); await drain();
  await vi.advanceTimersByTimeAsync(900); await drain();
  expect(nodes(tree).some((n) => text(n).includes('本地草稿保存失败'))).toBe(true);
  button('✓ 完成').onClick(); await drain();
  expect(editor().readOnly).toBe(false);
  expect(editor().doc).toBe('KEEP MY IDEA');
  h.failWrites = false;
  button('✓ 完成').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('KEEP MY IDEA');
  expect(editor().readOnly).toBe(true);
});

test('related draft analysis captures unsaved text without submitting to the PC', async () => {
  props.client.saveFile = vi.fn();
  render(); await drain(); await edit();
  editor().onDocChange('from tools import build\nbuild()\n'); await drain();
  button('⋯').onClick(); await drain();
  button('关联草稿').onClick(); await drain();
  const panel = nodes(tree).find((node) => node.type?.name === 'PythonContextPanel').props;
  expect(panel.query.request.content).toBe('from tools import build\nbuild()\n');
  expect(panel.query.request.source).toBe('draft');
  expect(props.client.saveFile).not.toHaveBeenCalled();
});

test('cross-file navigation refuses stale results and preserves the outgoing draft', async () => {
  const fresh = { ...data, path: 'tools.py', content: 'def build(): pass', version: 'sha256:' + '2'.repeat(64) };
  props.client.readFile = async () => fresh;
  props.onOpenRelated = vi.fn();
  render(); await drain(); await edit();
  editor().onDocChange('MY CURRENT IDEA'); await drain();
  button('⋯').onClick(); await drain(); button('关联草稿').onClick(); await drain();
  let panel = nodes(tree).find((node) => node.type?.name === 'PythonContextPanel').props;
  await expect(panel.onNavigate({ path: 'tools.py', line: 1, version: data.version })).rejects.toThrow('已变化');
  expect(props.onOpenRelated).not.toHaveBeenCalled();
  await panel.onNavigate({ path: 'tools.py', line: 1, version: fresh.version }); await drain();
  expect(props.onOpenRelated).toHaveBeenCalledWith(fresh, 1, { data, mode: 'edit' });
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY CURRENT IDEA');
});

test('app navigation returns through visited files before leaving the viewer', async () => {
  renderApp = true;
  render(); await drain();
  const project = { id: 'p', name: 'demo', revision: 1 };
  nodes(tree).find((node) => node.type?.name === 'ProjectListScreen').props.onOpenProject(project);
  await drain();
  nodes(tree).find((node) => node.type?.name === 'ExplorerScreen').props.onOpenFile(data);
  await drain();
  const original = nodes(tree).find((node) => node.type?.name === 'FileScreen').props;
  original.onOpenRelated({ ...data, path: 'tools.py' }, 7, { data, mode: 'edit' }); await drain();
  const related = nodes(tree).find((node) => node.type?.name === 'FileScreen').props;
  expect(related.initialData.path).toBe('tools.py');
  expect(related.initialLine).toBe(7);
  related.onBack(); await drain();
  const restored = nodes(tree).find((node) => node.type?.name === 'FileScreen').props;
  expect(restored.initialData.path).toBe('a.py');
  expect(restored.initialLine).toBeUndefined();
  expect(restored.initialMode).toBe('edit');
  restored.onBack(); await drain();
  expect(nodes(tree).some((node) => node.type?.name === 'ExplorerScreen')).toBe(true);
});

test('an explicit target line takes priority over an asynchronously loaded old read position', async () => {
  h.readTop = 1500;
  props.initialLine = 7;
  render(); await drain();
  expect(editor().scrollRequest.line).toBe(7);
  expect(editor().initialScrollTop).toBeNull();
});
