import { useEffect, useState } from 'react';
import { ActionSheet } from '../../ui/Controls';
import { deleteMark, loadMarks, locateMark, saveMark, type ReadingMark } from '../../storage/readingStore';
import { newDraftId } from '../../storage/draftStore';

export function ReadingTools({ projectId, path, content, version, line, endLine, onJump, onClose }: {
  projectId: string; path: string; content: string; version: string; line: number; endLine: number;
  onJump: (line: number) => void; onClose: () => void;
}) {
  const [marks, setMarks] = useState<ReadingMark[]>([]);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<ReadingMark | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = content.split('\n');
  const start = Math.max(1, Math.min(line, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  useEffect(() => { let active = true; void loadMarks(projectId, path).then((v) => { if (active) setMarks(v); }).catch((e) => { if (active) setError(e.message); }); return () => { active = false; }; }, [projectId, path]);
  const run = async (operation: () => Promise<ReadingMark[]>, clearInput = true) => {
    if (busy) return; setBusy(true); setError(null);
    try { setMarks(await operation()); if (clearInput) { setNote(''); setEditing(null); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，内容保留'); }
    finally { setBusy(false); }
  };
  const add = (kind: 'bookmark' | 'note') => {
    if (kind === 'note' && !note.trim()) return;
    const mark: ReadingMark = editing ? { ...editing, note: note.trim(), savedAt: new Date().toISOString() } : {
      id: newDraftId(), kind, line: start, endLine: end, quote: lines.slice(start - 1, end).join('\n'),
      note: kind === 'note' ? note.trim() : '', version, savedAt: new Date().toISOString(),
    };
    void run(() => saveMark(projectId, path, mark));
  };
  return <ActionSheet title="书签与旁注" onClose={() => { if (!note.trim() || window.confirm('旁注还未保存，离开并放弃这次输入？')) onClose(); }}>
    <p className="hint">只保存在手机，不会写进项目代码。{editing ? `正在编辑 L${editing.line} 的旁注` : `当前标记 L${start}${end > start ? `–L${end}` : ''}`}</p>
    {error && <p className="hint hint--error" role="alert">{error}</p>}
    <textarea className="field__input reading-note-input" aria-label="旁注内容" placeholder="这段代码的理解、疑问，或下次要做的事…" value={note} maxLength={10000} onChange={(e) => setNote(e.target.value)} />
    <div className="btnrow"><button type="button" className="btn btn--primary" disabled={busy || !note.trim()} onClick={() => add('note')}>{editing ? '保存旁注' : '添加旁注'}</button>{!editing && <button type="button" className="btn" disabled={busy} onClick={() => add('bookmark')}>添加行书签</button>}{editing && <button type="button" className="btn" onClick={() => { setEditing(null); setNote(''); }}>取消编辑</button>}</div>
    {!marks.length && <p className="empty">轻点一行或选中一段代码，再到这里留下线索。</p>}
    <ul className="reading-mark-list">{marks.map((mark) => {
      const location = locateMark(mark, content);
      return <li key={mark.id} className="reading-mark"><button type="button" className="reading-mark__jump" onClick={() => { if (note.trim() && !window.confirm('旁注还未保存，离开并放弃这次输入？')) return; onJump(location.line); onClose(); }}><strong>{mark.kind === 'bookmark' ? '书签' : '旁注'} · L{location.line}</strong><span>{mark.note || mark.quote.slice(0, 100) || '空行'}</span></button>{mark.version !== version && <p className="hint">{location.matched ? '文件版本已变化，已按原文定位。' : '原文位置无法确认，跳转到原行号附近；请核对。'}</p>}<details><summary>标记时的代码</summary><pre className="reading-quote">{mark.quote || '（空行）'}</pre></details><div className="btnrow">{mark.kind === 'note' && <button type="button" className="draftcard__action" disabled={busy} onClick={() => { if (note.trim() && !window.confirm('放弃当前未保存的旁注输入？')) return; setEditing(mark); setNote(mark.note); }}>编辑旁注</button>}<button type="button" className="draftcard__action draftcard__action--danger" disabled={busy} onClick={() => { if (window.confirm('删除这条书签或旁注？')) void run(() => deleteMark(projectId, path, mark.id), editing?.id === mark.id); }}>删除</button></div></li>;
    })}</ul>
  </ActionSheet>;
}
