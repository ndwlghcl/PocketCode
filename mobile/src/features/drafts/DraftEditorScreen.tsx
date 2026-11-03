import { useCallback, useEffect, useRef, useState } from 'react';
import { upsertDraft, type FileDraft } from '../../storage/draftStore';
import { CodeEditor } from '../editor/CodeEditor';
import { shareText } from '../sharing/share';
import { useAppearance } from '../../app/Appearance';
import { Icon } from '../../ui/Icon';

/** 本地草稿自带完整正文；编辑与导出不依赖电脑、授权项目或文件缓存。 */
export function DraftEditorScreen({ draft, sourceAvailable, onBack, onOpenSource, registerBackGuard }: {
  draft: FileDraft; sourceAvailable: boolean; onBack: () => void;
  onOpenSource: (draft: FileDraft) => Promise<void>;
  registerBackGuard: (guard: (() => boolean) | null) => void;
}) {
  const { prefs } = useAppearance();
  const [text, setText] = useState(draft.content);
  const [state, setState] = useState<'saved' | 'pending' | 'error'>('saved');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef(text);
  const recordRef = useRef(draft);
  const savedText = useRef(draft.content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaving = useRef(false);
  const mounted = useRef(true);
  const cancelTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const persist = useCallback(async (): Promise<FileDraft | null> => {
    cancelTimer();
    const submitted = { ...recordRef.current, content: textRef.current, savedAt: new Date().toISOString() };
    try {
      const stored = await upsertDraft(submitted.projectId, submitted.path, submitted);
      recordRef.current = stored.drafts.find((item) => item.id === submitted.id)!;
      savedText.current = submitted.content;
      if (mounted.current) { setState(textRef.current === submitted.content ? 'saved' : 'pending'); setError(null); }
      return submitted;
    } catch (cause) {
      if (mounted.current) { setState('error'); setError(cause instanceof Error ? cause.message : '草稿保存失败，请重试或导出备份'); }
      return null;
    }
  }, [cancelTimer]);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; cancelTimer();
      if (savedText.current !== textRef.current) void persistRef.current();
    };
  }, [cancelTimer]);
  const leave = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true; setBusy(true);
    try { if (await persist()) onBack(); }
    finally { leaving.current = false; if (mounted.current) setBusy(false); }
  }, [onBack, persist]);
  useEffect(() => {
    registerBackGuard(() => { void leave(); return true; });
    return () => registerBackGuard(null);
  }, [leave, registerBackGuard]);

  const exportDraft = async () => {
    const result = await shareText(`草稿 · ${recordRef.current.name}`, textRef.current);
    if (!result.ok) setError(result.message ?? '导出失败');
  };
  const openSource = async () => {
    if (leaving.current || !sourceAvailable) return;
    leaving.current = true; setBusy(true);
    try { const saved = await persist(); if (saved) await onOpenSource(saved); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '来源不可用，草稿仍保存在本机'); }
    finally { leaving.current = false; if (mounted.current) setBusy(false); }
  };

  return <section className="file-workspace file-workspace--full">
    <header className="code-toolbar">
      <button type="button" className="icon-button" aria-label="保存草稿并返回" disabled={busy} onClick={() => void leave()}><Icon name="back" /></button>
      <div className="code-title"><strong>{draft.name}</strong><small>{draft.projectName ?? '本地草稿'} · {draft.path}</small></div>
      <button type="button" className="btn" disabled={busy} onClick={() => void persist()}>保存草稿</button>
      <button type="button" className="icon-button" aria-label="导出草稿" onClick={() => void exportDraft()}><Icon name="share" /></button>
    </header>
    <p className="file-notice">{sourceAvailable ? '正在编辑本地草稿；打开来源时会核验文件，保存草稿不会修改电脑。' : '来源不可用：仍可编辑、保存和导出本地草稿。'}{state === 'saved' ? ' 已保存在本机。' : state === 'pending' ? ' 有修改待保存。' : ' 本地保存失败，请勿关闭，可重试或导出。'}</p>
    {error && <p className="file-notice file-notice--error" role="alert">{error}</p>}
    <CodeEditor className="cmhost cmhost--editfull" fileName={draft.path} doc={text} readOnly={busy} wrap={prefs.wrap}
      onDocChange={(value) => {
        textRef.current = value; setText(value); setState('pending'); cancelTimer();
        timer.current = setTimeout(() => void persist(), 700);
      }} onBlur={() => { if (savedText.current !== textRef.current) void persist(); }} />
    <footer className="code-footer"><button type="button" disabled={!sourceAvailable || busy} onClick={() => void openSource()}>打开来源文件，检查并保存到电脑</button></footer>
  </section>;
}
