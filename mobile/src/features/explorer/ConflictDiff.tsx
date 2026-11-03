import { useMemo } from 'react';
import { lineDiff } from '../editor/lineDiff';
import { ActionSheet } from '../../ui/Controls';

export function ConflictDiff({ computer, draft, onClose, title = '查看冲突差异', beforeLabel = '电脑最新内容', afterLabel = '当前手机草稿' }: { computer: string; draft: string; onClose: () => void; title?: string; beforeLabel?: string; afterLabel?: string }) {
  const result = useMemo(() => lineDiff(computer, draft), [computer, draft]);
  const changed = result.lines.map((line, index) => line.kind === 'same' ? -1 : index).filter((index) => index >= 0);
  // 只展示变更及相邻三行上下文，避免大文件首次变更在底部时看不到。
  const visible = new Set<number>();
  for (const index of changed) for (let i = Math.max(0, index - 3); i <= Math.min(result.lines.length - 1, index + 3); i++) visible.add(i);
  const indices = [...visible].sort((a, b) => a - b);
  return <ActionSheet title={title} onClose={onClose}>
    <p className="hint">− {beforeLabel}　＋ {afterLabel}。比较不会修改任一版本。</p>
    {result.coarse && <p className="hint">变更较多，按整段增删显示。</p>}
    {!changed.length && <p className="hint">正文相同，可能只有编码或换行格式不同。</p>}
    <div className="conflict-diff" role="region" aria-label={`${beforeLabel}与${afterLabel}的逐行差异`} tabIndex={0}>
      {indices.slice(0, 800).map((index, offset) => {
        const line = result.lines[index];
        return <div key={index}>
          {(offset === 0 && index > 0 || offset > 0 && index > indices[offset - 1] + 1) && <div className="conflict-diff__gap">⋯ 省略未变更行</div>}
          <div className={`conflict-diff__line ${line.kind === 'added' ? 'diff-add' : line.kind === 'removed' ? 'diff-del' : ''}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><b>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b><code>{line.text || ' '}</code></div>
        </div>;
      })}
    </div>
    {indices.length > 800 && <p className="hint">仅显示前 800 行差异及上下文，请导出草稿后完整比较。</p>}
    <button type="button" className="btn" onClick={onClose}>关闭对比</button>
  </ActionSheet>;
}
