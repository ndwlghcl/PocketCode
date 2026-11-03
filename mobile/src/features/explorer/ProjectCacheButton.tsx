import { useEffect, useState } from 'react';
import type { PocketCodeClient } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { cacheJobs } from './cacheJobs';

export function useCacheJob(projectId: string) {
  const [job, setJob] = useState(() => cacheJobs.get(projectId));
  useEffect(() => {
    setJob(cacheJobs.get(projectId));
    const remove = cacheJobs.subscribe(() => setJob(cacheJobs.get(projectId)));
    void cacheJobs.load(projectId); return remove;
  }, [projectId]);
  return job;
}
export function ProjectCacheButton({ client, projectId, online, revoked, onManage, compact = false }: {
  client: PocketCodeClient | null; projectId: string; online: boolean; revoked: boolean; onManage?: () => void; compact?: boolean;
}) {
  const { busy, progress, error, finishedAt, stopping, clearing } = useCacheJob(projectId);
  return <div className="project-cache">
    <div className="project-cache__actions">
      <button type="button" className="btn" onClick={() => { if (client && online && !revoked && !busy && !clearing) void cacheJobs.start(projectId, client); }} disabled={!client || !online || revoked || busy || !!clearing}><Icon name="download" size={16} />{clearing ? '正在清理…' : busy ? '正在缓存项目…' : '一键缓存项目'}</button>
      {busy && <button type="button" className="btn" disabled={stopping} onClick={() => void cacheJobs.stop(projectId)}>停止</button>}
      {!busy && !!progress?.failedPaths?.length && <button type="button" className="btn" disabled={!client || !online || revoked || !!clearing} onClick={() => { if (client && online && !revoked && !busy) void cacheJobs.start(projectId, client, new Set(progress.failedPaths)); }}>重试失败项（{progress.failedPaths.length}）</button>}
      {onManage && <button type="button" className="btn" onClick={onManage}>管理缓存</button>}
    </div>
    {!compact && !progress && !error && <p className="hint">批量保存代码，断网也能看；跳过依赖、敏感配置和超限文件。单文件最多 1 MB，本次最多 50 MiB。</p>}
    {busy && <><p className="hint">可在应用内切换页面，任务继续；应用被系统关闭会中断，已缓存内容保留。</p><progress aria-label="项目缓存进度" value={progress?.completed ?? 0} max={progress?.total || 1} /></>}
    <div role="status" aria-live="polite">
      {busy && <p className="hint">{stopping ? '正在停止，等待当前请求结束…' : progress ? `已处理 ${progress.completed} / ${progress.total} 个文件` : '正在读取项目目录…'}</p>}
      {progress && <p className="hint">{!busy ? progress.stopped ? `缓存已停止：${progress.stopped}。` : '本次缓存完成。' : ''}新缓存 {progress.saved} · 已是最新 {progress.reused} · 跳过 {progress.skipped} · 失败 {progress.failed}</p>}
      {finishedAt && !busy && <p className="hint">上次任务 {new Date(finishedAt).toLocaleString('zh-CN')}</p>}
      {progress?.truncated && <p className="hint hint--error">目录已截断，本次只缓存已列出的文件。</p>}
      {error && <p className="hint hint--error" role="alert">{error}</p>}
    </div>
    {!!progress?.issues.length && <details><summary>查看未缓存原因（{progress.skipped + progress.failed}）</summary><ul className="project-cache__issues">{progress.issues.map((item, index) => <li key={`${item.path}:${index}`}>{item.path}：{item.reason}</li>)}</ul>{progress.skipped + progress.failed > 50 && <p className="hint">原因仅显示前 50 项；重试会包含全部失败项。未处理文件可再次点击一键缓存。</p>}</details>}
  </div>;
}
