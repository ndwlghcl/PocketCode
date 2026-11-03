import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Component-only hook harness: native UI, editor, and network are replaced.
// Run the real FileScreen handlers, effects, and draftStore; no Android/E2E claim.
const h = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false,
  kv: new Map<string, string>(), saved: [] as any[],
  failWrites: false,
  failReads: false,
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
    get: async (key: string) => { if (h.failReads) throw new Error('disk read error'); return h.kv.get(key) ?? null; },
    set: async (key: string, value: string) => {
      if (h.failWrites) throw new Error('disk full');
      h.kv.set(key, value);
    },
    remove: async (key: string) => { h.kv.delete(key); },
    keys: async (prefix: string) => [...h.kv.keys()].filter((key) => key.startsWith(prefix)),
  },
}));
vi.mock('../src/storage/cacheStore', () => ({ saveCachedFile: async (_id: any, data: any) => { h.saved.push(data); }, loadCachedProjects: async () => null, saveCachedProjects: async () => {} }));
vi.mock('../src/features/editor/CodeEditor', () => ({ CodeEditor: 'mock-editor' }));
vi.mock('../src/features/sharing/share', () => ({ shareText: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/storage/readPositionStore', () => ({
  createPositionSaver: () => ({ flush: async () => {}, push: () => {} }),
  loadReadPosition: async () => h.readTop === null ? null : { scrollTop: h.readTop },
}));
vi.mock('../src/storage/uiPrefs', () => ({ loadWrapPref: async () => true, saveWrapPref: async () => {} }));
vi.mock('../src/app/Appearance', () => ({ useAppearance: () => ({ prefs: { wrap: true }, update() {} }) }));
vi.mock('../src/app/useConnection', () => ({ useConnection: () => ({
  status: { state: 'online', latencyMs: 1 },
  pairing: { baseUrl: 'https://test', deviceToken: 'token', fingerprint: 'sha256:' + '1'.repeat(64), serverName: 'test' },
}) }));

import { FileScreen } from '../src/features/explorer/FileScreen';
import { loadDrafts, upsertDraft } from '../src/storage/draftStore';
import { App } from '../src/app/App';
import { DraftEditorScreen } from '../src/features/drafts/DraftEditorScreen';
import { DraftsScreen } from '../src/features/drafts/DraftsScreen';
import { PocketCodeError } from '../src/api/client';
import { shareText } from '../src/features/sharing/share';

let tree: any;
let props: any;
let renderApp = false;
let renderLocalDraft = false;
let renderDraftsBox = false;
const data = { path: 'a.py', content: 'PC OLD', version: 'sha256:' + '1'.repeat(64), encoding: 'utf-8', newline: 'LF', size: 6, mtime: '2026-10-26T00:00:00Z', read_only: false };
const render = () => {
  h.cursor = 0; h.dirty = false;
  tree = renderApp ? App() : renderLocalDraft ? DraftEditorScreen(props) : renderDraftsBox ? DraftsScreen(props) : FileScreen(props);
  const effects = h.effects.splice(0);
  effects.forEach((fn) => fn());
};
const drain = async () => {
  for (let i = 0; i < 70; i++) { await Promise.resolve(); if (h.dirty) render(); }
};
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = (node: any): string => typeof node === 'number' ? String(node) : typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
const button = (label: string) => {
  const found = nodes(tree).find((n) => (n.type === 'button' || n.type?.name === 'MenuItem') && (n.props['aria-label'] ?? text(n).trim()) === label);
  if (!found) throw new Error('Missing button ' + label);
  return found.props;
};
const editor = () => nodes(tree).find((n) => n.type === 'mock-editor').props;
const edit = async () => {
  button('编辑').onClick(); await drain();
};
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = []; h.cursor = 0; h.effects = []; h.dirty = false; h.kv.clear(); h.saved = [];
  h.failWrites = false;
  h.failReads = false;
  h.readTop = null;
  renderApp = false;
  renderLocalDraft = false; renderDraftsBox = false;
  vi.stubGlobal('window', { confirm: vi.fn(() => true), scrollTo: vi.fn(), scrollY: 0 });
  props = { client: {}, projectId: 'p', initialData: { ...data }, online: true, revoked: false,
    onBack() {}, registerBackGuard() {} };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

test('轻点仅记录符号，代码导航必须主动打开；非空选区优先复制分享', async () => {
  render(); await drain();
  expect(editor().onSymbolPress).toBeUndefined();
  editor().onCursorSymbol({ symbol: 'hello', line: 1 }); await drain();
  expect(nodes(tree).some((n) => n.type?.name === 'ActionSheet')).toBe(false);
  expect(button('代码导航').disabled).toBe(false);
  button('代码导航').onClick(); await drain();
  expect(nodes(tree).some((n) => n.type?.name === 'ActionSheet')).toBe(true);
  editor().onSelection({ text: 'hello', startLine: 1, endLine: 1 }); await drain();
  expect(button('代码导航').disabled).toBe(true);
  expect(button('复制')).toBeDefined(); expect(button('写旁注')).toBeDefined();
});

test('另存为使用新建的不覆盖接口，保留原文件基线和草稿', async () => {
  props.client.createEntry = vi.fn(async () => ({ path: 'copy.py', type: 'file' }));
  (window as any).prompt = vi.fn(() => 'copy.py');
  render(); await drain(); await edit();
  editor().onDocChange('MY COPY'); await drain();
  button('更多操作').onClick(); await drain(); button('另存为新文件').onClick(); await drain();
  expect(props.client.createEntry).toHaveBeenCalledWith('p', expect.objectContaining({ path: 'copy.py', content: 'MY COPY', type: 'file' }));
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY COPY');
  expect(editor().doc).toBe('MY COPY');
});

test('reading refresh preserves the active draft through editing', async () => {
  await upsertDraft('p', 'a.py', { id: 'draft1', name: 'idea', path: 'a.py', projectId: 'p', content: 'MY PRECIOUS IDEA', baseVersion: data.version, savedAt: data.mtime });
  props.client.readFile = async () => ({ ...data, content: 'PC NEW', version: 'sha256:' + '3'.repeat(64) });
  render(); await drain();
  button('更多操作').onClick(); await drain();
  button('刷新').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY PRECIOUS IDEA');
  button('编辑').onClick(); await drain();
  expect(editor().doc).toBe('MY PRECIOUS IDEA');
  button('完成编辑').onClick(); await drain();
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
  button('完成编辑').onClick(); await drain();
  expect(editor().readOnly).toBe(false);
  expect(editor().doc).toBe('KEEP MY IDEA');
  h.failWrites = false;
  button('完成编辑').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('KEEP MY IDEA');
  expect(editor().readOnly).toBe(true);
});

test('related draft analysis captures unsaved text without submitting to the PC', async () => {
  props.client.saveFile = vi.fn();
  render(); await drain(); await edit();
  editor().onDocChange('from tools import build\nbuild()\n'); await drain();
  button('更多操作').onClick(); await drain();
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
  button('更多操作').onClick(); await drain(); button('关联草稿').onClick(); await drain();
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

test('read-mode diagnostics inspect the displayed PC content rather than a different local draft', async () => {
  await upsertDraft('p', 'a.py', { id: 'draft1', name: 'idea', path: 'a.py', projectId: 'p', content: 'DIFFERENT DRAFT', baseVersion: data.version, savedAt: data.mtime });
  props.client.diagnose = vi.fn(async () => ({ diagnostics: [], analyzer: 'ast' }));
  render(); await drain();
  button('更多操作').onClick(); await drain();
  button('检查语法与诊断').onClick(); await drain();
  expect(props.client.diagnose).toHaveBeenCalledWith('p', { path: 'a.py', content: 'PC OLD' });
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('DIFFERENT DRAFT');
});

test('returning from a tool menu leaves the edited buffer open and the next back saves it', async () => {
  props.registerBackGuard = vi.fn();
  render(); await drain(); await edit();
  editor().onDocChange('KEEP THIS BUFFER'); await drain();
  button('更多操作').onClick(); await drain();
  expect(props.registerBackGuard.mock.calls.at(-1)[0]()).toBe(true); await drain();
  expect(editor().readOnly).toBe(false);
  expect(editor().doc).toBe('KEEP THIS BUFFER');
  expect(props.registerBackGuard.mock.calls.at(-1)[0]()).toBe(true); await drain();
  expect(editor().readOnly).toBe(true);
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('KEEP THIS BUFFER');
});

test('draft read failure is visible, preserves original bytes and blocks saving to PC', async () => {
  await upsertDraft('p', 'a.py', { id: 'd', name: 'idea', path: 'a.py', projectId: 'p', content: 'KEEP OLD', baseVersion: data.version, savedAt: data.mtime });
  const original = h.kv.get('pc.draft.p.a.py');
  h.failReads = true;
  props.client.saveFile = vi.fn();
  render(); await drain();
  expect(text(tree)).toContain('无法读取草稿');
  await edit(); editor().onDocChange('NEW BUFFER'); await drain();
  button('保存').onClick(); await drain();
  expect(props.client.saveFile).not.toHaveBeenCalled();
  expect(h.kv.get('pc.draft.p.a.py')).toBe(original);
  expect(editor().doc).toBe('NEW BUFFER');
});

test('draft box opens the complete local draft without pairing, project list or file cache', async () => {
  const draft = { id: 'd', name: 'idea', path: 'a.py', projectId: 'removed-project', content: 'LOCAL ONLY', baseVersion: data.version, savedAt: data.mtime };
  await upsertDraft(draft.projectId, draft.path, draft);
  renderDraftsBox = true;
  props = { client: null, online: false, onOpenDraft: vi.fn() };
  render(); await drain();
  expect(button('去编辑').disabled).toBe(false);
  button('去编辑').onClick(); await drain();
  expect(props.onOpenDraft).toHaveBeenCalledWith(expect.objectContaining({ content: 'LOCAL ONLY' }));
});

test('a hanging computer request does not delay the local draft list', async () => {
  await upsertDraft('p', 'a.py', { id: 'd', name: 'idea', path: 'a.py', projectId: 'p', content: 'LOCAL', baseVersion: data.version, savedAt: data.mtime });
  renderDraftsBox = true;
  props = { client: { listProjects: () => new Promise(() => {}) }, online: true, onOpenDraft: vi.fn() };
  render(); await drain();
  expect(text(tree)).toContain('共 1 份草稿');
  expect(button('去编辑').disabled).toBe(false);
});

test('local draft editor saves and exports without a source; failed persistence prevents leaving', async () => {
  const draft = { id: 'd', name: 'idea', path: 'a.py', projectId: 'removed-project', content: 'OLD', baseVersion: data.version, savedAt: data.mtime, encoding: 'utf-8-bom', newline: 'CRLF' };
  await upsertDraft(draft.projectId, draft.path, draft as any);
  renderLocalDraft = true;
  props = { draft, sourceAvailable: false, onBack: vi.fn(), onOpenSource: vi.fn(), registerBackGuard: vi.fn() };
  render(); await drain();
  expect(text(tree)).toContain('来源不可用');
  editor().onDocChange('MY NEW IDEA'); await drain();
  h.failWrites = true;
  button('保存草稿并返回').onClick(); await drain();
  expect(props.onBack).not.toHaveBeenCalled();
  expect(editor().doc).toBe('MY NEW IDEA');
  button('导出草稿').onClick(); await drain();
  expect(shareText).toHaveBeenCalledWith('草稿 · idea', 'MY NEW IDEA');
  h.failWrites = false;
  button('保存草稿并返回').onClick(); await drain();
  expect(props.onBack).toHaveBeenCalledTimes(1);
  expect((await loadDrafts(draft.projectId, draft.path)).drafts[0]).toMatchObject({ content: 'MY NEW IDEA', encoding: 'utf-8-bom', newline: 'CRLF' });
});

test('opening the source first persists the local buffer and source errors do not discard it', async () => {
  const draft = { id: 'd', name: 'idea', path: 'a.py', projectId: 'p', content: 'OLD', baseVersion: data.version, savedAt: data.mtime };
  await upsertDraft('p', 'a.py', draft);
  renderLocalDraft = true;
  props = { draft, sourceAvailable: true, onBack: vi.fn(), registerBackGuard: vi.fn(), onOpenSource: vi.fn(async () => {
    expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('NEW');
    throw new Error('来源文件已移除');
  }) };
  render(); await drain(); editor().onDocChange('NEW'); await drain();
  button('打开来源文件，检查并保存到电脑').onClick(); await drain();
  expect(props.onOpenSource).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain('来源文件已移除');
  expect(editor().doc).toBe('NEW');
});

test('conflict diff reads the latest PC version and does not overwrite either side', async () => {
  props.client.saveFile = vi.fn(async (_id: string, _body: any) => { throw new PocketCodeError(409, 'VERSION_CONFLICT', 'conflict', undefined, { current_version: 'sha256:' + '2'.repeat(64) }); });
  const fresh = { ...data, content: 'PC CHANGED', version: 'sha256:' + '3'.repeat(64) };
  props.client.readFile = vi.fn(async () => fresh);
  render(); await drain(); await edit(); editor().onDocChange('MY DRAFT'); await drain();
  button('保存').onClick(); await drain();
  expect(button('查看差异').className).toBe('btn btn--primary');
  expect(button('覆盖电脑文件').className).toBe('btn');
  button('查看差异').onClick(); await drain();
  const panel = nodes(tree).find((n) => n.type?.name === 'ConflictDiff');
  expect(panel.props).toMatchObject({ computer: 'PC CHANGED', draft: 'MY DRAFT' });
  expect(props.client.saveFile).toHaveBeenCalledTimes(1);
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('MY DRAFT');
  panel.props.onClose(); await drain();
  button('覆盖电脑文件').onClick(); await drain();
  expect(props.client.saveFile.mock.calls.at(-1)[1].base_version).toBe(fresh.version);
  expect(text(tree)).toContain('查看差异'); // 电脑再次冲突，继续保留草稿。
});

test('keeping a conflicted draft or cancelling discard never deletes it', async () => {
  props.client.saveFile = async () => { throw new PocketCodeError(409, 'VERSION_CONFLICT', 'conflict', undefined, { current_version: data.version }); };
  render(); await drain(); await edit(); editor().onDocChange('KEEP ME'); await drain();
  button('保存').onClick(); await drain();
  vi.mocked(window.confirm).mockReturnValue(false);
  button('放弃修改，加载电脑版').onClick(); await drain();
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('KEEP ME');
  button('保留草稿，继续编辑').onClick(); await drain();
  expect(editor().doc).toBe('KEEP ME');
  expect((await loadDrafts('p', 'a.py')).drafts[0].content).toBe('KEEP ME');
  expect(text(tree)).toContain('草稿已保留');
});
