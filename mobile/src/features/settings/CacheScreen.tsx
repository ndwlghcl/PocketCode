import { useEffect, useState } from 'react';
import type { PocketCodeClient } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { loadCachedProjects, saveCachedProjects } from '../../storage/cacheStore';
import { cacheInventory, type CacheInventory } from '../../storage/cacheInventory';
import { diskStorage } from '../../native';
import { cacheJobs } from '../explorer/cacheJobs';
import { ProjectCacheButton, useCacheJob } from '../explorer/ProjectCacheButton';
import { Icon } from '../../ui/Icon';

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function CacheCard({ project, client, online, revoked }: { project: ProjectSummary; client: PocketCodeClient | null; online: boolean; revoked: boolean }) {
  const [inventory, setInventory] = useState<CacheInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const job = useCacheJob(project.id);
  const refresh = () => cacheInventory(project.id).then(setInventory).catch((e) => setError(e.message));
  useEffect(() => { let active = true; void cacheInventory(project.id).then((v) => { if (active) setInventory(v); }).catch((e) => { if (active) setError(e.message); }); return () => { active = false; }; }, [project.id, job.busy]);
  const clear = async () => {
    if (clearing || !window.confirm(`清理「${project.name}」的文件和目录缓存？\n将先停止该项目缓存任务。草稿、书签和旁注会保留。`)) return;
    setClearing(true); setError(null);
    try { await cacheJobs.clear(project.id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '清理未全部完成，请重试'); }
    finally { setClearing(false); }
  };
  return <article className="workspace-card"><h2>{project.name}</h2>
    {inventory ? <><p className="cache-summary"><strong>{inventory.files}</strong> 个文件可离线阅读 · {sizeText(inventory.bytes)}</p><p className="hint">目录共 {inventory.directoryFiles} 个文件，{inventory.current} 个已缓存版本一致。{inventory.stale > 0 ? `另有 ${inventory.stale} 个旧版或目录外缓存。` : ''}</p><p className="hint">{inventory.fetchedAt ? `目录更新于 ${new Date(inventory.fetchedAt).toLocaleString('zh-CN')}` : '还没有目录快照。'}{inventory.truncated ? '目录不完整，文件总数仅包含已列出的部分。' : ''}{inventory.unreadable ? `${inventory.unreadable} 个缓存无法读取，可重新缓存。` : ''}</p></> : <p className="hint">正在统计缓存…</p>}
    <ProjectCacheButton compact projectId={project.id} client={client} online={online && !clearing} revoked={revoked} />
    <button type="button" className="btn" disabled={clearing} onClick={() => void clear()}>{clearing ? '正在清理…' : '清理此项目缓存'}</button>
    {error && <p className="hint hint--error" role="alert">{error}</p>}
  </article>;
}
export function CacheScreen({ client, online, revoked, onBack }: { client: PocketCodeClient | null; online: boolean; revoked: boolean; onBack: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const cached = await loadCachedProjects();
      const entries = new Map((cached?.projects ?? []).map((p) => [p.id, p]));
      for (const key of await diskStorage.keys('pc.cache.manifest.')) {
        const id = key.slice('pc.cache.manifest.'.length);
        if (!entries.has(id)) entries.set(id, { id, name: `本地项目 ${id.slice(0, 8)}`, revision: 0 });
      }
      for (const key of await diskStorage.keys('pc.cache.file.')) {
        const id = key.slice('pc.cache.file.'.length).split('.')[0];
        if (id && !entries.has(id)) entries.set(id, { id, name: `本地项目 ${id.slice(0, 8)}`, revision: 0 });
      }
      if (active) setProjects([...entries.values()]);
      if (client && online && !revoked) {
        const response = await client.listProjects(); await saveCachedProjects(response.projects);
        for (const project of response.projects) entries.set(project.id, project);
        if (active) setProjects([...entries.values()]);
      }
    })().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '缓存列表读取失败'); });
    return () => { active = false; };
  }, [client, online, revoked]);
  return <section><div className="navrow"><button type="button" className="navrow__back" aria-label="返回" onClick={onBack}><Icon name="back" /></button><span className="navrow__title">离线缓存</span></div><p className="hint">清理缓存会保留草稿、书签和旁注。电脑上的新变化需联网更新缓存。</p><details className="hint"><summary>缓存范围与限制</summary><p>跳过依赖、敏感配置和超限文件；单文件最多 1 MB，本次最多 50 MiB。空间为代码正文的估算大小。</p></details>{error && <p className="hint hint--error">{error}</p>}{!projects.length && !error && <p className="empty">还没有可管理的项目缓存。</p>}{projects.map((p) => <CacheCard key={p.id} project={p} client={client} online={online} revoked={revoked} />)}</section>;
}
