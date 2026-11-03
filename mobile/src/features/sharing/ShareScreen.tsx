import { ActionSheet } from '../../ui/Controls';
import { Icon } from '../../ui/Icon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ManifestDir, ProjectSummary } from '../../api/types';
import { PocketCodeClient } from '../../api/client';
import {
  loadCachedManifest,
  saveCachedManifest,
} from '../../storage/cacheStore';
import {
  buildMultiFileText,
  bundleTotalChars,
  detectSensitivePaths,
} from '../sharing/bundle';
import { copyText, shareText, shareArchive } from './share';
import { archiveName, buildShareArchive } from './archive';
import { indexShareTree, visibleShareRows, selectionState, toggleSharePaths, type ShareEntry, type ShareFileEntry } from './selection';
import { prepareBundle, type PreparedBundle, type ShareFormat } from './prepareBundle';

interface Props {
  client: PocketCodeClient | null;
  project: ProjectSummary;
  online: boolean;
  revoked: boolean;
  onBack: () => void;
}

const RENDER_CAP = 400;

/**
 * 多文件分享（S4f，PRD §8.1）：勾选文件 → 预览清单/总大小/来源/敏感提示 →
 * 生成文本包或 ZIP。在线取电脑版（顺带刷新缓存），离线只用缓存
 * 并明确标注来源。
 */
export function ShareScreen({ client, project, online, revoked, onBack }: Props) {
  const [files, setFiles] = useState<ShareFileEntry[] | null>(null);
  const [tree, setTree] = useState<ShareEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ShareFormat>('text');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preview, setPreview] = useState<PreparedBundle | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [sharing, setSharing] = useState(false);
  const active = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);

  const usable = online && !revoked;

  useEffect(() => {
    setPreview(null); setPreparing(false);
    return () => { active.current?.abort(); active.current = null; loadSequence.current++; };
  }, [client, project.id, revoked]);

  const loadFiles = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (revoked) { setFiles([]); setTree([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      let root: ManifestDir | null = null;
      let fetchedAt: string | null = null;
      let fromCache = false;
      if (client && usable) {
        try {
          const manifest = await client.getManifest(project.id);
          root = manifest.root;
          fetchedAt = manifest.generated_at;
          await saveCachedManifest(project.id, manifest);
        } catch {
          root = null;
        }
      }
      if (!root) {
        fromCache = true;
        const cached = await loadCachedManifest(project.id);
        if (cached) {
          root = cached.root;
          fetchedAt = cached.fetchedAt;
        }
      }
      if (sequence !== loadSequence.current) return;
      if (!root) {
        setError(usable ? '目录读取失败' : '离线且没有目录缓存，无法选择文件');
        setFiles([]); setTree([]); setSelected(new Set());
        return;
      }
      const indexed = indexShareTree(root);
      setFiles(indexed.files); setTree(indexed.tree);
      const valid = new Set(indexed.files.map((file) => file.path));
      setSelected((previous) => new Set([...previous].filter((path) => valid.has(path))));
      setNotice(
        !fromCache
          ? null
          : `目录来自本地缓存（${fetchedAt?.slice(0, 19).replace('T', ' ') ?? '未知时间'}）；未缓存正文无法离线分享。`,
      );
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : '目录读取失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [client, project.id, usable, revoked]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(() => (files ?? []).filter((file) => !needle || file.path.toLowerCase().includes(needle)), [files, needle]);
  const rows = useMemo(() => visibleShareRows(tree, expanded, needle), [tree, expanded, needle]);
  const visible = rows.slice(0, RENDER_CAP);
  const hiddenCount = rows.length - visible.length;

  const selectVisible = () => {
    setSelected((previous) => toggleSharePaths(previous, filtered.map((file) => file.path)));
  };

  const prepare = async () => {
    if (!files || selected.size === 0 || active.current || revoked || loading) return;
    const controller = new AbortController(); active.current = controller;
    setPreparing(true);
    setProgress(0); setNotice(null);
    setError(null);
    try {
      const chosen = files
        .filter((file) => selected.has(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      const result = await prepareBundle(client, project.id, chosen.map((file) => file.path), usable, format,
        (done) => { if (active.current === controller) setProgress(done); }, controller.signal);
      if (active.current === controller && !controller.signal.aborted) setPreview(result);
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '分享准备失败');
    } finally {
      if (active.current === controller) { active.current = null; setPreparing(false); if (controller.signal.aborted) setNotice('已取消准备'); }
    }
  };

  const doShare = async () => {
    if (!preview || sharing || revoked) return;
    setSharing(true); setError(null);
    try {
    const text = preview.format === 'text' ? buildMultiFileText({
      projectName: project.name,
      files: preview.files,
      source: preview.source,
      fetchedAt: preview.fetchedAt,
    }) : '';
    const outcome = preview.format === 'zip'
      ? await shareArchive(archiveName(project.name), await buildShareArchive(project.name, preview))
      : await shareText(`多文件分享 · ${project.name}`, text);
    setNotice(
      outcome.ok
        ? outcome.downloaded ? '已下载 ZIP 压缩包' : outcome.cancelled ? '已取消分享' : outcome.copied
          ? '分享面板不可用，已复制全文到剪贴板'
          : null
        : outcome.message ?? '分享失败',
    );
    if (outcome.ok && !outcome.cancelled) setPreview(null);
    else if (!outcome.ok) setError(outcome.message ?? '分享失败，请重试');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '打包失败，请重试'); }
    finally { setSharing(false); }
  };

  const doCopy = async () => {
    if (!preview || preview.format !== 'text' || sharing || revoked) return;
    const text = buildMultiFileText({
      projectName: project.name,
      files: preview.files,
      source: preview.source,
      fetchedAt: preview.fetchedAt,
    });
    const outcome = await copyText(text);
    setNotice(outcome.ok ? '已复制全文到剪贴板' : outcome.message ?? '复制失败');
    if (!outcome.ok) setError(outcome.message ?? '复制失败');
  };

  const sensitive = useMemo(
    () => detectSensitivePaths(preview?.files.map((file) => file.path) ?? []),
    [preview],
  );

  if (revoked) return <section><button type="button" className="btn" onClick={onBack}>返回目录</button><p className="hint hint--error">电脑授权已撤销，无法分享项目文件；本地草稿仍可在草稿箱单独导出。</p></section>;

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          <Icon name="back" size={20} /><span className="visually-hidden">返回目录</span>
        </button>
        <div className="navrow__stack">
          <span className="navrow__title">分享 · {project.name}</span>
          <span className="navrow__meta">选择文件或整个文件夹，分享文本包或 ZIP</span>
        </div>
      </div>
      {notice ? (
        <div className="result result--ok">
          <p className="result__title">✔ {notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      <input
        className="field__input"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="按路径过滤文件"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={preparing || sharing}
      />
      <div className="btnrow share-formats" role="group" aria-label="分享格式">
        <button type="button" className="btn" aria-pressed={format === 'text'} disabled={preparing || sharing} onClick={() => { setFormat('text'); setError(null); }}>文本包</button>
        <button type="button" className="btn" aria-pressed={format === 'zip'} disabled={preparing || sharing} onClick={() => { setFormat('zip'); setError(null); }}>ZIP 压缩包</button>
      </div>
      <p className="hint">勾选文件夹会选中全部子文件，不受展开、过滤或显示条数影响；再次勾选可取消。一次最多 1000 个文件。</p>
      {format === 'zip' && <p className="hint">ZIP 保留相对目录，正文导出为 UTF-8 文本，总计最多 10 MiB；另附来源说明。二进制文件不支持导出。</p>}
      <div className="btnrow">
        <button type="button" className="btn" onClick={selectVisible} disabled={loading || preparing || sharing || !filtered.length}>
          {needle ? '全选/取消筛选结果' : '全选/取消全部'}
        </button>
        <button type="button" className="btn" disabled={!selected.size || preparing || sharing} onClick={() => setSelected(new Set())}>清空选择</button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void prepare()}
          disabled={loading || preparing || sharing || selected.size === 0}
        >
          {preparing ? `正在准备 ${progress}/${selected.size}…` : `下一步（${selected.size}）`}
        </button>
        {preparing && <button type="button" className="btn" onClick={() => { active.current?.abort(); setNotice('正在取消准备…'); }}>停止准备</button>}
      </div>
      {files === null ? <p className="hint">正在读取文件列表…</p> : null}
      {files !== null && files.length === 0 ? <p className="empty">项目里没有可选文件。</p> : null}
      {hiddenCount > 0 ? (
        <p className="hint">当前显示前 {RENDER_CAP} 项，可用过滤缩小范围；全选和文件夹勾选仍包含未显示的文件。项目共 {files?.length} 个文件。</p>
      ) : null}
      <ul className="cardlist">
        {visible.map((file) => {
          const paths = file.type === 'dir' ? file.paths : [file.path];
          const checked = selectionState(selected, paths);
          return <li key={file.path}>
          <div className="share-tree__row" style={{ paddingLeft: Math.min(file.depth, 5) * 12 }}>
            {file.type === 'dir' && <button type="button" className="icon-button" aria-label={`${expanded.has(file.path) ? '收起' : '展开'} ${file.path}`} aria-expanded={!!needle || expanded.has(file.path)} disabled={!!needle || preparing || sharing || loading} onClick={() => setExpanded((previous) => {
              const next = new Set(previous); if (next.has(file.path)) next.delete(file.path); else next.add(file.path); return next;
            })}><Icon name={needle || expanded.has(file.path) ? 'down' : 'chevron'} size={15} /></button>}
            <button type="button" className="cardlist__item" role="checkbox" aria-checked={checked} aria-label={`选择${file.type === 'dir' ? '文件夹' : '文件'} ${file.path}`} title={file.path} disabled={preparing || sharing || loading || !paths.length} onClick={() => setSelected((previous) => toggleSharePaths(previous, paths))}>
              <span className="cardlist__name sharecheck__path">
                <Icon name={checked === true ? 'check' : checked === 'mixed' ? 'minus' : file.type === 'dir' ? 'folder' : 'file'} size={17} /> {file.name}{checked === 'mixed' ? '（部分选中）' : ''}
              </span>
              <span className="cardlist__meta">{file.type === 'dir' ? `${file.paths.length} 个文件` : `${file.size} B`}</span>
            </button>
          </div></li>;
        })}
      </ul>

      {preview ? (
        <ActionSheet title="分享预览" onClose={() => { if (!sharing) setPreview(null); }}>
            <p className="sheet__title">{preview.format === 'zip' ? 'ZIP 分享预览' : '文本包预览'}（{preview.files.length} 个文件）</p>
            {error && <p className="hint hint--error" role="alert">{error}</p>}
            <p className="sheet__empty">
              来源：{preview.source === 'pc' ? '电脑当前版本' : '包含本地缓存（可能过期）'}
              {preview.fetchedAt
                ? `（${preview.fetchedAt.slice(0, 19).replace('T', ' ')}）`
                : ''}
              · 共 {bundleTotalChars(preview.files)} 字符 · {(preview.bytes / 1024).toFixed(1)} KiB 正文
            </p>
            {preview.format === 'zip' && <p className="hint">压缩包包含以上文件和一份分享来源说明；代码保留相对目录，以 UTF-8 文本保存。</p>}
            <ul className="sheet__list">
              {preview.files.slice(0, 30).map((file) => (
                <li key={file.path}>
                  <span className="sheet__item">
                    <span className="sheet__name">{file.path}</span>
                  </span>
                </li>
              ))}
              {preview.files.length > 30 ? (
                <li>
                  <span className="sheet__item sheet__empty">
                    …另有 {preview.files.length - 30} 个文件
                  </span>
                </li>
              ) : null}
            </ul>
            {sensitive.length > 0 ? (
              <p className="hint hint--error">
                ⚠ 疑似敏感文件：{sensitive.map((hit) => hit.path).join('、')}。请确认内容不含凭据再分享。
              </p>
            ) : null}
            {preview.skipped.length > 0 ? (
              <details className="share-skipped"><summary>跳过 {preview.skipped.length} 个文件，点击查看原因</summary><ul>{preview.skipped.slice(0, 30).map((item) => <li key={item.path}>{item.path}：{item.reason}</li>)}</ul>{preview.skipped.length > 30 && <p className="hint">仅显示前 30 项原因。</p>}</details>
            ) : null}
            <div className="btnrow">
              {preview.format === 'text' && <button type="button" className="btn" disabled={sharing} onClick={() => void doCopy()}>
                <Icon name="copy" size={16} /> 复制全文
              </button>}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void doShare()}
                disabled={sharing}
              >
                <Icon name="share" size={16} /> {sharing ? '正在打包/分享…' : preview.format === 'zip' ? '分享 ZIP 压缩包' : '系统分享'}
              </button>
            </div>
            <div className="btnrow">
              <button type="button" className="btn" disabled={sharing} onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
        </ActionSheet>
      ) : null}
    </section>
  );
}
