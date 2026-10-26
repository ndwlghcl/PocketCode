import { ActionSheet, IconButton } from '../../ui/Controls';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PythonContextRequest, PythonContextResponse, PythonLocation, PythonRelatedFile } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { bundleTotalChars, detectSensitivePaths, SOURCE_LABEL, type BundleFile } from '../sharing/bundle';
import { copyText, shareText } from '../sharing/share';
import { collectContextBundle, contextBundleText, initialContextSelection } from './contextBundle';

export type ContextView = 'definitions' | 'references' | 'related';
export interface ContextQuery { request: PythonContextRequest; view: ContextView }

interface Props {
  client: PocketCodeClient;
  projectId: string;
  projectName: string;
  query: ContextQuery;
  online: boolean;
  revoked: boolean;
  onClose: () => void;
  onNavigate: (location: PythonLocation | PythonRelatedFile) => Promise<void>;
}

/** 主动触发的静态分析与分享抽屉。不会运行代码或自动写回电脑。 */
export function PythonContextPanel({ client, projectId, projectName, query, online, revoked,
  onClose, onNavigate }: Props) {
  const [result, setResult] = useState<PythonContextResponse | null>(null);
  const [view, setView] = useState<ContextView>(query.view);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<BundleFile[] | null>(null);
  // 连接状态每 15 秒更新客户端实例，不因此重置用户勾选或分享预览。
  const clientRef = useRef(client);
  clientRef.current = client;
  const sequence = useRef(0);
  const usable = online && !revoked;
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setBusy(true); setError(null); setNotice(null); setPreview(null);
    try {
      const response = await clientRef.current.pythonContext(projectId, query.request);
      if (seq !== sequence.current) return;
      setResult(response);
      setSelected(initialContextSelection(response));
    } catch (cause) {
      if (seq !== sequence.current) return;
      setError(cause instanceof PocketCodeError && cause.code === 'NOT_FOUND'
        ? '电脑端尚未提供 Python 关联接口，请更新并重启电脑端。'
        : cause instanceof Error ? cause.message : '分析失败');
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  }, [projectId, query]);
  useEffect(() => {
    void load();
    return () => { sequence.current++; };
  }, [load]);

  const toggle = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
    setPreview(null);
  };
  const prepare = async () => {
    if (!result || !usable) return;
    setBusy(true); setError(null);
    try {
      setPreview(await collectContextBundle(clientRef.current, projectId, query.request, result, selected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '准备分享失败');
    } finally { setBusy(false); }
  };
  const exportText = async (copy: boolean) => {
    if (!result || !preview) return;
    setBusy(true); setError(null);
    try {
      const text = contextBundleText(projectName, result, preview, query.request);
      const outcome = copy ? await copyText(text) : await shareText(`Python 关联 · ${projectName}`, text);
      if (outcome.ok) setNotice(outcome.copied || copy ? '已复制完整关联文本包' : '已打开系统分享');
      else setError(outcome.message ?? '分享失败');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '分享失败'); }
    finally { setBusy(false); }
  };
  const navigate = async (item: PythonLocation | PythonRelatedFile) => {
    setBusy(true); setError(null);
    try { await onNavigate(item); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '打开失败'); }
    finally { setBusy(false); }
  };
  const locationList = (items: PythonLocation[]) => items.length ? (
    <ul className="sheet__list">
      {items.map((item, i) => <li key={`${item.path}:${item.line}:${i}`}>
        <button type="button" className="sheet__item context-location" disabled={busy || !usable}
          onClick={() => void navigate(item)}>
          <span className="sheet__name">
            <strong>{item.confidence === 'resolved' ? '静态定位' : '同名候选'} · {item.name}</strong>
            <small>{item.path}:{item.line} · {item.reason}</small>
            <code>{item.text}</code>
          </span>
        </button>
      </li>)}
    </ul>
  ) : <p className="sheet__empty">没有可确认的结果；无法识别的动态关系不会自动猜测。</p>;
  const paths = result ? [result.path, ...result.related_files.map((file) => file.path)] : [];
  const sensitive = new Set(detectSensitivePaths(paths).map((item) => item.path));
  const previewText = result && preview ? contextBundleText(projectName, result, preview, query.request) : '';

  return <ActionSheet title={`Python 智能关联${query.request.symbol ? ` · ${query.request.symbol}` : ''}`} onClose={onClose}>
      <div className="navrow">
        <span className="hint">静态分析 · 按需展开</span><IconButton icon="refresh" label="重新分析" onClick={() => void load()} disabled={busy || !usable} />
      </div>
      <p className="hint">{query.request.path} · 仅静态分析，点击结果才会跳转。</p>
      <div className="btnrow context-tabs">
        <button type="button" className="btn" aria-pressed={view === 'definitions'} onClick={() => setView('definitions')}>定义（{result?.definitions.length ?? 0}）</button>
        <button type="button" className="btn" aria-pressed={view === 'references'} onClick={() => setView('references')}>引用（{result?.references.length ?? 0}）</button>
        <button type="button" className="btn" aria-pressed={view === 'related'} onClick={() => setView('related')}>关联（{result?.related_files.length ?? 0}）</button>
      </div>
      {busy ? <p className="hint">正在处理…</p> : null}
      {error ? <p className="hint hint--error" role="alert">{error}</p> : null}
      {notice ? <p className="hint">{notice}</p> : null}
      {!usable ? <p className="hint hint--error">电脑不可用：新的项目关联分析和读取暂不可用，本地草稿仍保留。</p> : null}
      {result ? <>
        <p className="hint">来源：{SOURCE_LABEL[result.source]} · 已分析 {result.scanned_files} 个 Python 文件
          {result.truncated ? ' · ⚠ 范围不完整' : ''}</p>
        {view === 'definitions' ? locationList(result.definitions) : view === 'references' ? locationList(result.references) : <>
          <p className="hint">勾选后生成预览；同名候选和疑似敏感文件默认不选。</p>
          <ul className="sheet__list">
            <li className="context-file">
              <label><input type="checkbox" disabled={busy} checked={selected.has(result.path)} onChange={() => toggle(result.path)} />
                <span>{result.path}<small>当前入口 · {SOURCE_LABEL[result.source]}{sensitive.has(result.path) ? ' · ⚠ 疑似敏感' : ''}</small></span>
              </label>
            </li>
            {result.related_files.map((item) => <li key={item.path} className="context-file">
              <label><input type="checkbox" disabled={busy} checked={selected.has(item.path)} onChange={() => toggle(item.path)} />
                <span>{item.path}<small>{item.confidence === 'resolved' ? '静态关联' : '候选'} · 电脑版
                  {sensitive.has(item.path) ? ' · ⚠ 疑似敏感' : ''}</small>
                  <small>{item.reasons.join('；')}</small></span>
              </label>
              <button type="button" className="btn" disabled={busy || !usable} onClick={() => void navigate(item)}>打开</button>
            </li>)}
          </ul>
          <button type="button" className="btn btn--primary" disabled={busy || !usable || !selected.size}
            onClick={() => void prepare()}>生成分享预览（{selected.size}）</button>
        </>}
        <details className="context-warnings"><summary>分析范围与限制</summary>
          <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
        {preview ? <div className="context-preview-wrap">
          <p className="sheet__title">分享预览 · {preview.length} 个文件 · {bundleTotalChars(preview)} 字符</p>
          {preview.map((file) => <p className="hint" key={file.path}>{file.path} · {SOURCE_LABEL[file.source ?? 'pc']}</p>)}
          {preview.some((file) => sensitive.has(file.path)) ? <p className="hint hint--error">包含疑似敏感文件，请核对正文后再分享。</p> : null}
          <pre className="context-preview">{previewText.slice(0, 8000)}</pre>
          {previewText.length > 8000 ? <p className="hint">界面仅预览前 8000 字符；复制和分享使用全文。</p> : null}
          <div className="btnrow">
            <button type="button" className="btn" disabled={busy} onClick={() => void exportText(true)}>复制全文</button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void exportText(false)}>系统分享</button>
          </div>
        </div> : null}
      </> : null}
  </ActionSheet>;
}
