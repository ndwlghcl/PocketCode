import { useEffect, useRef, useState } from 'react';
import type { PocketCodeClient } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { cacheProject, type ProjectCacheProgress } from './cacheProject';

export function ProjectCacheButton({ client, projectId, online, revoked }: {
  client: PocketCodeClient | null; projectId: string; online: boolean; revoked: boolean;
}) {
  const [progress, setProgress] = useState<ProjectCacheProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false); setStopping(false); setProgress(null); setError(null);
    return () => { active.current?.abort(); active.current = null; };
  }, [projectId, client]);
  useEffect(() => { if (!online || revoked) active.current?.abort(); }, [online, revoked]);

  const start = async () => {
    if (!client || !online || revoked || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setStopping(false); setError(null); setProgress(null);
    try {
      const result = await cacheProject(client, projectId, {
        signal: controller.signal,
        onProgress: (value) => { if (active.current === controller) setProgress(value); },
      });
      if (active.current === controller) setProgress(result);
    } catch (cause) {
      if (active.current === controller) setError(cause instanceof Error ? cause.message : '项目缓存失败');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); setStopping(false); }
    }
  };

  return <div className="project-cache">
    <div className="project-cache__actions">
      <button type="button" className="btn" onClick={() => void start()} disabled={!client || !online || revoked || busy}>
        <Icon name="download" size={16} />{busy ? '正在缓存项目…' : '一键缓存项目'}
      </button>
      {busy && <button type="button" className="btn" disabled={stopping} onClick={() => { setStopping(true); active.current?.abort(); }}>停止</button>}
    </div>
    {!progress && !error && <p className="hint">批量保存代码，断网也能看；跳过依赖、敏感配置和超限文件。单文件最多 1 MB，本次最多 50 MiB。</p>}
    {busy && <p className="hint">请留在此页；停止或离开后，已缓存的文件仍会保留。</p>}
    {busy && <progress aria-label="项目缓存进度" value={progress?.completed ?? 0} max={progress?.total || 1} />}
    <div role="status" aria-live="polite">
      {busy && <p className="hint">{stopping ? '正在停止，等待当前请求结束…' : progress ? `已处理 ${progress.completed} / ${progress.total} 个文件` : '正在读取项目目录…'}</p>}
      {progress && <p className="hint">{!busy ? progress.stopped ? `缓存已停止：${progress.stopped}。` : '本次缓存完成。' : ''}新缓存 {progress.saved} · 已是最新 {progress.reused} · 跳过 {progress.skipped} · 失败 {progress.failed} · {(progress.bytes / 1024 / 1024).toFixed(2)} MiB</p>}
      {progress?.truncated && <p className="hint hint--error">电脑返回的目录已截断，本次只缓存已列出的文件。</p>}
      {error && <p className="hint hint--error">{error}</p>}
    </div>
    {!!progress?.issues.length && <details><summary>查看未缓存原因（{progress.skipped + progress.failed}）</summary><ul className="project-cache__issues">{progress.issues.map((item) => <li key={item.path}>{item.path}：{item.reason}</li>)}</ul>{progress.skipped + progress.failed > 50 && <p className="hint">仅显示前 50 项。</p>}</details>}
  </div>;
}
