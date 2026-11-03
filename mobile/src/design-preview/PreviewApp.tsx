import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CodeEditor } from '../features/editor/CodeEditor';
import { sortEntries } from '../features/explorer/sortEntries';
import type { ManifestNode } from '../api/types';
import { APP_BUILD } from '../app/version';
import { Icon, type IconName } from './Icon';
import landscape from './landscape.svg';

type Scheme = 'a' | 'b' | 'c';
type Page = 'projects' | 'files' | 'code' | 'settings' | 'drafts';
type Mode = 'light' | 'dark' | 'system';
const pages: { id: Page; name: string; icon: IconName }[] = [
  { id: 'projects', name: '项目', icon: 'folder' },
  { id: 'files', name: '文件浏览', icon: 'outline' },
  { id: 'code', name: '代码阅读', icon: 'code' },
  { id: 'settings', name: '设置', icon: 'settings' },
  { id: 'drafts', name: '草稿箱', icon: 'drafts' },
];
const schemes = [
  { id: 'a' as const, name: '晴彩', english: 'Daylight', line: '把灵感，放进口袋。', description: '奶白底色 / 彩色项目卡 / 圆润胶囊导航', note: '明亮、轻快。用柔和彩块区分项目，留白集中在内容之间。', colors: ['#7863c8', '#ed9b7b', '#b7c8a0', '#f7f5f0'] },
  { id: 'b' as const, name: '山岚', english: 'Landscape', line: '在自己的风景里，读代码。', description: '山水背景 / 通透分组 / 悬浮工具栏', note: '自然、通透。背景留在面板之外，代码区用实底保证可读性。', colors: ['#327867', '#c5d9ca', '#f0c9a5', '#e9efdf'] },
  { id: 'c' as const, name: '夜航', english: 'After hours', line: '安静一点，专注多一点。', description: '暖墨底色 / 细线列表 / 琥珀色游标', note: '细腻、利落。紧凑的列表与工具栏，把更多屏幕留给代码。', colors: ['#dfb46d', '#a8c4ba', '#aaa1cd', '#25272a'] },
];

// 所有方案共享同一份演示内容；不读取连接、真实草稿或业务存储。
const code = `from fastapi import FastAPI

from pocketcode.server.routes.health import (
    router as health_router,
)
from pocketcode.server.routes.projects import (
    router as projects_router,
)


def create_app(settings=None, store=None):
    """构建 PocketCode 的本地服务。"""
    app = FastAPI(
        title="PocketCode Server",
        version="1.0.0-s3",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.state.settings = settings
    app.state.store = store

    # 按合同注册只读接口
    app.include_router(health_router)
    app.include_router(projects_router)

    return app
`;

function file(name: string): ManifestNode {
  return { type: 'file', name, path: name, size: 1024, mtime: '2026-10-26T06:28:00Z', version: 'sha256:preview', read_only: false };
}
function dir(name: string, children: ManifestNode[]): ManifestNode {
  return { type: 'dir', name, path: name, children };
}
const tree = [dir('desktop', [dir('pocketcode', [dir('server', [dir('routes', [file('health.py'), file('projects.py')]), file('app.py'), file('schemas.py')])])]), dir('docs', [file('HANDOFF.md'), file('PRD_v1.1.md')]), dir('mobile', [dir('src', [file('main.tsx')]), file('package.json')]), file('README.md')];

function IconButton({ icon, label, onClick, active = false }: { icon: IconName; label: string; onClick: () => void; active?: boolean }) {
  return <button className={`icon-button ${active ? 'is-active' : ''}`} title={label} aria-label={label} onClick={onClick}><Icon name={icon} /></button>;
}
function Toggle({ value, onChange, label }: { value: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className="toggle" role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}><span /></button>;
}
function Range({ label, value, unit = '%', min = 0, max = 100, onChange }: { label: string; value: number; unit?: string; min?: number; max?: number; onChange: (n: number) => void }) {
  const id = useId();
  return <div className="range-row"><label htmlFor={id}>{label}<output>{value}{unit}</output></label><input id={id} type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ '--range': `${(value - min) / (max - min) * 100}%` } as CSSProperties} /></div>;
}

function Phone({ scheme, requestedPage, compact = false }: { scheme: Scheme; requestedPage: Page; compact?: boolean }) {
  const [page, setPage] = useState(requestedPage);
  const [mode, setMode] = useState<Mode>(scheme === 'c' ? 'dark' : 'light');
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [image, setImage] = useState<string | null>(scheme === 'b' ? landscape : null);
  const [opacity, setOpacity] = useState(65);
  const [mask, setMask] = useState(24);
  const [blur, setBlur] = useState(0);
  const [fontSize, setFontSize] = useState(13);
  const [wrap, setWrap] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [expanded, setExpanded] = useState(new Set(['desktop', 'desktop/pocketcode', 'desktop/pocketcode/server']));
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('PocketCode');
  const [fileName, setFileName] = useState('app.py');
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState(code);
  const [sheet, setSheet] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [drafts, setDrafts] = useState(['服务路由整理', '错误处理的想法']);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [searchCode, setSearchCode] = useState(false);
  const [codeQuery, setCodeQuery] = useState('');
  const [scrollRequest, setScrollRequest] = useState<{ line: number; nonce: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  useEffect(() => { setPage(requestedPage); setSheet(null); setEditing(false); }, [requestedPage]);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 2600); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => previous?.focus();
  }, [sheet]);
  const navigate = (next: Page) => { setPage(next); setSheet(null); setEditing(false); };
  const notice = (message: string) => { setSheet(null); setToast(message); };
  const back = () => editing ? setEditing(false) : navigate(page === 'code' ? 'files' : 'projects');
  const openFile = (name: string) => { setFileName(name); setDoc(name === 'app.py' ? code : `# ${name}\n# 设计预览示例\n\n${code}`); navigate('code'); };
  const searchInCode = () => {
    const line = doc.split('\n').findIndex((text) => text.toLowerCase().includes(codeQuery.toLowerCase()));
    if (line >= 0 && codeQuery.trim()) setScrollRequest({ line: line + 1, nonce: Date.now() });
    else notice('当前代码中没有找到匹配内容');
  };
  const chooseImage = (selected: File | undefined) => {
    if (!selected) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) { setToast('预览支持 JPG、PNG、WebP 图片'); return; }
    if (selected.size > 12 * 1024 * 1024) { setToast('预览请选择小于 12 MB 的图片'); return; }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(selected);
    setImage(objectUrl.current);
    setToast('仅在本次浏览器预览中显示，刷新后恢复');
  };
  const renderTree = (nodes: ManifestNode[], parent = '', level = 0): ReactNode => sortEntries(nodes).map((node) => {
    const path = `${parent}${node.name}`;
    const isDir = node.type === 'dir';
    const hasMatch = (entry: ManifestNode): boolean => entry.name.toLowerCase().includes(query.toLowerCase()) || (entry.type === 'dir' && entry.children.some(hasMatch));
    if (query && !hasMatch(node)) return null;
    const open = expanded.has(path) || !!query;
    return <div key={path}>
      <button className={`file-row ${node.name === 'app.py' ? 'file-row--focus' : ''}`} style={{ '--depth': level } as CSSProperties} onClick={() => {
        if (isDir) setExpanded((old) => { const next = new Set(old); next.has(path) ? next.delete(path) : next.add(path); return next; });
        else openFile(node.name);
      }}>
        <span className={`tree-arrow ${open && isDir ? 'tree-arrow--open' : ''}`}>{isDir && <Icon name="chevron" size={13} />}</span>
        <span className={`file-glyph ${isDir ? 'folder-glyph' : node.name.endsWith('.py') ? 'python-glyph' : ''}`}><Icon name={isDir ? 'folder' : node.name.endsWith('.py') ? 'code' : 'file'} size={20} /></span>
        <span>{node.name}</span>{node.name === 'app.py' && <i className="file-dot" />}
      </button>
      {isDir && open && renderTree(node.children, `${path}/`, level + 1)}
    </div>;
  });
  return <div ref={phoneRef} className={`phone scheme-${scheme} ${compact ? 'phone--compact' : ''}`} data-mode={dark ? 'dark' : 'light'} style={{ '--image-alpha': opacity / 100, '--mask-alpha': mask / 100, '--image-blur': `${blur}px`, '--code-size': `${fontSize}px` } as CSSProperties}>
    <div className="phone-background" aria-hidden="true">{image && <img src={image} alt="" />}<div /></div>
    <div className="system-bar"><span>9:41</span><span><Icon name="wifi" size={15} /><Icon name="battery" size={21} /></span></div>
    <div className={`phone-body page-${page}`} key={page}>
      {page === 'projects' && <>
        <div className="brandline"><span className="brand-mark"><Icon name="code" size={17} /></span><b>PocketCode</b><span className="tiny-label">YOUR POCKET WORKSPACE</span></div>
        <header className="home-heading"><div><p className="eyebrow">随时翻开，灵感不断线</p><h2>我的项目<span className="heading-dot">.</span></h2></div><IconButton icon="refresh" label="刷新项目" onClick={() => notice('演示项目已刷新')} /></header>
        <button className="connection-strip" onClick={() => setSheet('连接管理')}><span className="online-dot" /><span>岚的电脑<span className="connection-detail">已连接 · 12 ms</span></span><Icon name="chevron" size={16} /></button>
        <div className="section-label"><span>已授权项目</span><span>03</span></div>
        <div className="project-list">{[
          { name: 'PocketCode', desc: '把代码装进口袋', lang: 'TypeScript · Python', cache: '已缓存', icon: 'code' as const, revision: 42 },
          { name: 'my-agent', desc: '一点点，理解智能体', lang: 'Python', cache: '已缓存', icon: 'link' as const, revision: 18 },
          { name: 'learning-notes', desc: '值得留下的每个想法', lang: 'Markdown', cache: '已缓存', icon: 'file' as const, revision: 7 },
        ].map((item, index) => <button key={item.name} className={`project-card project-card--${index}`} onClick={() => { setProject(item.name); navigate('files'); }}>
          <span className="project-symbol"><Icon name={item.icon} size={24} /></span>
          <span className="project-copy"><strong>{item.name}</strong><span className="project-description">{item.desc}</span><span className="project-meta">{item.lang}<span>#{item.revision} · {item.cache}</span></span></span>
          <span className="project-arrow"><Icon name="chevron" size={18} /></span>
        </button>)}</div>
        <div className="home-footer"><Icon name="shield" size={15} /><span>你的代码，只在你的设备之间。</span></div>
        <div className="quiet-art" aria-hidden="true"><span>read.</span><span>think.</span><span>make.</span><i /></div>
      </>}
      {page === 'files' && <>
        <header className="page-heading"><IconButton icon="back" label="返回项目" onClick={back} /><div><p className="eyebrow">项目文件</p><h2>{project}</h2></div><IconButton icon="more" label="文件操作菜单" onClick={() => setSheet('文件操作')} /></header>
        <div className="explorer-toolbar"><label className="search-box"><Icon name="search" size={18} /><input aria-label="筛选文件名" placeholder="查找文件…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="清除筛选" onClick={() => setQuery('')}><Icon name="close" size={16} /></button>}</label><IconButton icon="git" label="Git 变更" onClick={() => setSheet('Git 变更')} /><IconButton icon="plus" label="新建文件或文件夹" onClick={() => setSheet('新建')} /></div>
        <div className="breadcrumb"><Icon name="folder" size={14} /><span>{project}</span><span>/</span><span>根目录</span></div>
        <div className="file-panel"><div className="file-panel-label"><span>名称</span><span>按名称排序</span></div>{renderTree(tree)}{query && !tree.some(function hit(n): boolean { return n.name.toLowerCase().includes(query.toLowerCase()) || (n.type === 'dir' && n.children.some(hit)); }) && <p className="empty-state">没有匹配的文件</p>}</div>
        <div className="file-footnote"><span className="online-dot" />目录已同步<span>快照 #42</span></div>
      </>}
      {page === 'code' && <>
        <header className="code-heading"><IconButton icon="back" label={editing ? '完成编辑' : '返回文件浏览'} onClick={back} /><div><strong>{fileName}</strong><span>server / {editing ? '本地编辑' : '只读'}</span></div><IconButton icon="search" label="搜索代码" active={searchCode} onClick={() => setSearchCode(!searchCode)} /><IconButton icon={editing ? 'check' : 'edit'} label={editing ? '保留本次演示修改' : '编辑代码'} onClick={() => { setEditing(!editing); if (editing) setToast('本次预览修改已保留；没有写入真实草稿或电脑'); }} /><IconButton icon="more" label="代码更多操作" onClick={() => setSheet('代码工具')} /></header>
        {searchCode && <form className="code-search" onSubmit={(e) => { e.preventDefault(); searchInCode(); }}><input aria-label="搜索代码内容" placeholder="在文件中查找…" value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} /><button type="submit">查找</button></form>}
        <div className="code-context"><span className="language-dot" />Python<span className="code-path">{project} / desktop</span><span className="read-badge">{editing ? '编辑中' : '已同步'}</span></div>
        <div className={`code-surface ${numbers ? '' : 'hide-numbers'}`}><CodeEditor doc={doc} readOnly={!editing} fileName={fileName} wrap={wrap} onDocChange={setDoc} scrollRequest={scrollRequest} /></div>
        <div className="code-status"><button onClick={() => setSheet('代码大纲')}><Icon name="outline" size={16} />大纲</button><button onClick={() => setSheet('智能关联')}><Icon name="link" size={16} />关联</button><span>UTF-8 · {doc.split('\n').length} 行</span></div>
      </>}
      {page === 'settings' && <>
        <header className="settings-heading"><p className="eyebrow">MAKE IT YOURS</p><h2>你的 PocketCode<span className="heading-dot">.</span></h2><p>让每一次打开，都合你心意。</p></header>
        <div className="live-preview"><span className="live-preview-icon"><Icon name="image" size={23} /></span><div><strong>属于你的阅读空间</strong><span>背景与遮罩 · 调节即刻可见</span></div><span className="live-dot" /></div>
        <div className="settings-section-label">外观</div>
        <section className="settings-group"><div className="setting-label"><Icon name="sun" size={18} /><strong>显示模式</strong></div><div className="mode-picker">{([{ id: 'light', icon: 'sun', label: '浅色' }, { id: 'dark', icon: 'moon', label: '深色' }, { id: 'system', icon: 'system', label: '系统' }] as const).map((m) => <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}><Icon name={m.icon} size={17} />{m.label}</button>)}</div>
          <div className="setting-row background-row"><span><Icon name="image" size={18} />背景图片</span><div><button className="text-action" onClick={() => fileInput.current?.click()}>{image ? '更换' : '选择图片'}</button>{image && <button className="text-action muted" onClick={() => { setImage(null); if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; } }}>清除</button>}</div></div>
          <input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择预览背景图片" onChange={(e) => { chooseImage(e.target.files?.[0]); e.target.value = ''; }} />
          <Range label="图片透明度" value={opacity} onChange={setOpacity} />
          <Range label="遮罩强度" value={mask} onChange={setMask} />
          <Range label="背景模糊" value={blur} max={20} unit=" px" onChange={setBlur} />
          <button className="restore-link" onClick={() => { setImage(scheme === 'b' ? landscape : null); setOpacity(65); setMask(24); setBlur(0); }}>恢复方案默认背景</button>
        </section>
        <div className="settings-section-label">代码显示</div><section className="settings-group"><Range label="字体大小" value={fontSize} min={11} max={20} unit=" px" onChange={setFontSize} /><div className="setting-row"><span>自动折行</span><Toggle label="自动折行" value={wrap} onChange={setWrap} /></div><div className="setting-row"><span>显示行号</span><Toggle label="显示行号" value={numbers} onChange={setNumbers} /></div></section>
        <div className="settings-section-label">应用</div><section className="settings-group"><button className="setting-row setting-button" onClick={() => setSheet('连接管理')}><span><span className="online-dot" />岚的电脑</span><span className="setting-end">已连接<Icon name="chevron" size={16} /></span></button><div className="version-row"><span>版本 1.0-s5a1 · 构建号 10</span><small>{APP_BUILD}</small></div></section>
        <p className="preview-disclaimer">交互演示：设置仅保留在本页会话；Android 相册、私有存储与重启恢复待选定方案后实现。</p>
      </>}
      {page === 'drafts' && <>
        <header className="home-heading"><div><p className="eyebrow">想法，先留在这里</p><h2>草稿箱<span className="heading-dot">.</span></h2></div><IconButton icon="refresh" label="刷新草稿" onClick={() => notice('演示草稿已刷新')} /></header><div className="draft-note"><Icon name="shield" size={18} />保存在这台设备，离线也能继续。</div><div className="section-label"><span>本地草稿</span><span>0{drafts.length}</span></div>
        {drafts.map((name) => <div className="draft-card" key={name}><span className="draft-symbol"><Icon name="drafts" size={22} /></span><button className="draft-copy" onClick={() => { setFileName('app.py'); navigate('code'); setEditing(true); }}><strong>{name}</strong><span>PocketCode / server / app.py</span><small><span className="online-dot" />已保存在本机 · 14:28</small></button><IconButton icon="more" label={`${name}的操作`} onClick={() => { setDeleting(name); setSheet('草稿操作'); }} /></div>)}
        {!drafts.length && <div className="empty-state"><Icon name="drafts" size={30} /><h3>留一点空间给新想法</h3><p>编辑文件时，草稿会在这里等你。</p><button className="text-action" onClick={() => setDrafts(['服务路由整理', '错误处理的想法'])}>恢复演示草稿</button></div>}
      </>}
    </div>
    {['projects', 'settings', 'drafts'].includes(page) && <nav className="phone-nav" aria-label="应用导航">{([{ id: 'projects', icon: 'folder', name: '项目' }, { id: 'drafts', icon: 'drafts', name: '草稿箱' }, { id: 'settings', icon: 'settings', name: '设置' }] as const).map((nav) => <button key={nav.id} aria-current={page === nav.id ? 'page' : undefined} onClick={() => navigate(nav.id)}><span><Icon name={nav.icon} size={21} /></span>{nav.name}</button>)}</nav>}
    <div className="gesture-bar"><span /></div>
    {toast && <div className="phone-toast" role="status">{toast}</div>}
    {sheet && <div className="sheet-scrim" onClick={() => setSheet(null)}><div ref={sheetRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-label={sheet} tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      if (e.key === 'Escape') setSheet(null);
      if (e.key === 'Tab') {
        const focusable = sheetRef.current?.querySelectorAll<HTMLButtonElement>('button');
        if (!focusable?.length) return;
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === sheetRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === sheetRef.current)) { e.preventDefault(); first.focus(); }
      }
    }}><div className="sheet-handle" /><header><h3>{sheet}</h3><IconButton icon="close" label="关闭操作面板" onClick={() => setSheet(null)} /></header>
      {sheet === '代码大纲' ? <><p className="sheet-hint">app.py · 1 个函数</p><button className="sheet-item" onClick={() => { setScrollRequest({ line: 11, nonce: Date.now() }); setSheet(null); }}><Icon name="code" /><span>create_app(settings, store)</span><small>11</small></button></> : sheet === '连接管理' ? <><div className="connection-card"><span className="online-dot" /><div><strong>岚的电脑</strong><p>局域网连接 · 12 ms · 演示状态</p></div><Icon name="system" /></div><button className="sheet-item" onClick={() => notice('设计预览不发起配对或网络请求')}><Icon name="refresh" />检查连接<span>演示</span></button></> : sheet === '草稿操作' ? <><p className="sheet-hint">{deleting}</p><button className="sheet-item danger" onClick={() => setSheet('确认删除草稿')}><Icon name="trash" />删除草稿</button></> : sheet === '确认删除草稿' ? <><p className="sheet-hint">删除「{deleting}」？这里只会移除演示数据。</p><button className="confirm-delete" onClick={() => { setDrafts(drafts.filter((name) => name !== deleting)); setDeleting(null); notice('演示草稿已删除'); }}>确认删除</button><button className="cancel-delete" onClick={() => setSheet(null)}>保留草稿</button></> : <>
        {(sheet === '代码工具' ? [{ icon: 'outline', label: '代码大纲', target: '代码大纲' }, { icon: 'link', label: '智能关联', target: '智能关联' }, { icon: 'shield', label: '检查诊断', target: '诊断' }, { icon: 'share', label: '分享文件或选区', target: '分享' }, { icon: 'refresh', label: '刷新电脑版本', target: '刷新' }]
          : sheet === '文件操作' ? [{ icon: 'search', label: '项目全文搜索', target: '项目搜索' }, { icon: 'share', label: '多文件分享', target: '分享' }, { icon: 'refresh', label: '刷新目录', target: '刷新' }]
          : sheet === '新建' ? [{ icon: 'file', label: '新建文件', target: '创建' }, { icon: 'folder', label: '新建文件夹', target: '创建' }]
          : sheet === 'Git 变更' ? [{ icon: 'git', label: 'main · 工作区干净', target: 'Git' }]
          : sheet === '智能关联' ? [{ icon: 'code', label: 'create_app · 定义', target: '定义' }, { icon: 'link', label: '引用与上下文', target: '引用' }]
          : [{ icon: 'check', label: '这是布局与交互示意', target: '演示' }]).map((item) => <button key={item.label} className="sheet-item" onClick={() => item.target === '代码大纲' || item.target === '智能关联' ? setSheet(item.target) : notice(`${item.label}：仅演示入口，未调用真实服务`)}><Icon name={item.icon as IconName} /><span>{item.label}</span><Icon name="chevron" size={16} /></button>)}
        <p className="sheet-hint">设计预览 · 服务操作与真实草稿不相连</p>
      </>}
    </div></div>}
  </div>;
}

export function PreviewApp() {
  const params = new URLSearchParams(location.search);
  const [page, setPage] = useState<Page>(pages.find((p) => p.id === params.get('page'))?.id ?? 'projects');
  const [focus, setFocus] = useState<Scheme | 'all'>(['a', 'b', 'c'].includes(params.get('scheme') ?? '') ? params.get('scheme') as Scheme : 'all');
  const [board, setBoard] = useState(false);
  const visibleSchemes = schemes.filter((scheme) => focus === 'all' || focus === scheme.id);
  const changePage = (next: Page) => { setPage(next); const url = new URL(location.href); url.searchParams.set('page', next); history.replaceState(null, '', url); };
  return <main className="design-studio">
    <header className="studio-top"><a className="studio-logo" href="/design-preview.html"><span><Icon name="code" size={20} /></span>PocketCode<span className="studio-wordmark">设计探索</span></a><span className="study-label"><i />PHASE 01 · 方向待选</span></header>
    <section className="studio-intro"><div><p className="studio-eyebrow">A LITTLE COLOR. A LITTLE FLOW.</p><h1>代码之外，<span>也有好风景。</span></h1><p className="studio-description">同一份代码，三种打开日常的方式。先看一看，再决定你的 PocketCode。</p></div><div className="studio-index"><span>03</span><p>视觉方向<br />由你选择，也可混搭</p></div></section>
    <div className="studio-controls"><div className="page-tabs" role="group" aria-label="同步比较页面">{pages.map((p) => <button key={p.id} aria-pressed={page === p.id && !board} onClick={() => { setBoard(false); changePage(p.id); }}><Icon name={p.icon} size={16} />{p.name}</button>)}</div><div className="studio-view-controls"><label className="scheme-select">比较<select aria-label="选择显示方案" value={focus} onChange={(e) => setFocus(e.target.value as Scheme | 'all')}><option value="all">全部方案</option>{schemes.map((s) => <option key={s.id} value={s.id}>{s.id.toUpperCase()} · {s.name}</option>)}</select></label><button className={`board-button ${board ? 'selected' : ''}`} aria-pressed={board} onClick={() => setBoard(!board)}><Icon name="outline" size={16} />四页全览</button></div></div>
    <p className="interaction-hint"><span />可以点：项目 → 目录 → 代码，也可切换底部导航；在设置中试试背景、主题和字号。</p>
    <div className={`scheme-grid ${focus !== 'all' ? 'scheme-grid--single' : ''}`}>{visibleSchemes.map((scheme) => <article className={`scheme-column column-${scheme.id}`} key={scheme.id}><header className="scheme-heading"><div><span className="scheme-letter">{scheme.id.toUpperCase()}</span><h2>{scheme.name}<small>{scheme.english}</small></h2><div className="swatches">{scheme.colors.map((color) => <i key={color} style={{ background: color }} />)}</div></div><p>{scheme.description}</p></header>
      {board ? pages.slice(0, 4).map((p) => <section className="board-section" key={p.id}><h3>{p.name}</h3><Phone scheme={scheme.id} requestedPage={p.id} compact /></section>) : <Phone scheme={scheme.id} requestedPage={page} />}
      <footer className="scheme-caption"><strong>{scheme.line}</strong><p>{scheme.note}</p><span>{scheme.id === 'a' ? '卡片节奏 · 胶囊导航' : scheme.id === 'b' ? '背景留白 · 浮岛导航' : '线性列表 · 下划线导航'}</span></footer>
    </article>)}</div>
    <footer className="studio-footer"><span>PocketCode / Design exploration v1.0</span><p>独立预览 · 不改正式 App · 示例数据 · 复用现有 CodeMirror</p><span>选配色、选布局，或自由混搭。</span></footer>
  </main>;
}
