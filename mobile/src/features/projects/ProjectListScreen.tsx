import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import type { ProbeResult } from '../../api/probe';
import {
  loadCachedProjects,
  saveCachedProjects,
} from '../../storage/cacheStore';
import { restoreWindowScroll, saveWindowScroll } from '../../app/scrollMemory';
import { Icon } from '../../ui/Icon';
import { loadRecents, type RecentFile } from '../../storage/readingStore';
import { cacheInventory, type CacheInventory } from '../../storage/cacheInventory';

interface Props {
  client: PocketCodeClient | null;
  paired: boolean;
  online: boolean;
  /** 定时连接检查完成后后台更新，客户端本身按凭据复用。 */
  lastProbe?: ProbeResult | null;
  onOpenProject: (project: ProjectSummary) => void;
  onResumeFile?: (project: ProjectSummary, path: string) => void;
  resuming?: boolean;
  resumeError?: string | null;
}

/**
 * 项目列表（S2c 真机反馈修订）：缓存秒开——先渲染本地缓存，再后台刷新。
 */
export function ProjectListScreen({ client, paired, online, lastProbe, onOpenProject, onResumeFile, resuming, resumeError }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [summaries, setSummaries] = useState<Record<string, CacheInventory | null>>({});
  useEffect(() => { let active = true; void loadRecents().then((v) => { if (active) setRecents(v); }); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(projects.map(async (project) => {
      try { return [project.id, await cacheInventory(project.id)] as const; }
      catch { return [project.id, null] as const; }
    })).then((v) => { if (active) setSummaries(Object.fromEntries(v)); });
    return () => { active = false; };
  }, [projects]);
  const availableRecents = recents.filter((recent) => projects.some((p) => p.id === recent.project.id));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 缓存秒开：先渲染本地缓存，再请求网络更新
      const cached = await loadCachedProjects();
      if (cancelled) return;
      if (cached) {
        setProjects(cached.projects);
        setCachedAt(cached.fetchedAt);
      }
      if (!client || !paired) return;
      setLoading(true);
      try {
        const response = await client.listProjects();
        if (cancelled) return;
        setProjects(response.projects);
        await saveCachedProjects(response.projects);
        setCachedAt(null);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        const fallback = await loadCachedProjects();
        if (fallback) {
          setProjects(fallback.projects);
          setCachedAt(fallback.fetchedAt);
        }
        setError(
          cause instanceof PocketCodeError && cause.code !== 'OFFLINE'
            ? cause.message
            : '无法获取最新列表，显示的是本地缓存',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, paired, online, lastProbe]);

  // 滚动位置记忆：返回本页时恢复
  const scrollRestored = useRef(false);
  useEffect(() => {
    const onScroll = () => saveWindowScroll('projects');
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      saveWindowScroll('projects');
    };
  }, []);
  useEffect(() => {
    if (!scrollRestored.current) {
      scrollRestored.current = true;
      restoreWindowScroll('projects');
    }
  }, []);

  if (!paired) {
    return (
      <section>
        <div className="brandline"><span><Icon name="code" size={18} /></span><b>PocketCode</b><small>YOUR POCKET WORKSPACE</small></div>
        <header className="page-intro"><p className="eyebrow">随时翻开，灵感不断线</p><h1>我的项目<span>.</span></h1></header>
        <p className="empty">还没有连接电脑。点击右上角的电脑图标，扫码配对后就能看到授权项目。</p>
      </section>
    );
  }

  return (
    <section>
      <div className="brandline"><span><Icon name="code" size={18} /></span><b>PocketCode</b><small>YOUR POCKET WORKSPACE</small></div>
      <header className="page-intro"><p className="eyebrow">随时翻开，灵感不断线</p><h1>我的项目<span>.</span></h1></header>
      {onResumeFile && availableRecents.length > 0 && <div className="continue-reading"><p className="eyebrow">接着上次的位置</p><button type="button" className="continue-reading__main" disabled={resuming} onClick={() => onResumeFile(projects.find((p) => p.id === availableRecents[0].project.id)!, availableRecents[0].path)}><span><strong>{availableRecents[0].path.split('/').pop()}</strong><small>{availableRecents[0].project.name} · {availableRecents[0].path}</small></span><Icon name="chevron" /></button>{availableRecents.length > 1 && <details><summary>最近阅读</summary><ul className="recent-files">{availableRecents.slice(1, 6).map((recent) => <li key={`${recent.project.id}:${recent.path}`}><button type="button" disabled={resuming} onClick={() => onResumeFile(projects.find((p) => p.id === recent.project.id)!, recent.path)}><span>{recent.path}</span><small>{recent.project.name}</small></button></li>)}</ul></details>}</div>}
      {resuming && <p className="hint" role="status">正在打开上次阅读的文件…</p>}
      {resumeError && <p className="hint hint--error" role="alert">{resumeError}</p>}
      <div className="section-label"><span>已授权项目</span><span>{String(projects.length).padStart(2, '0')}</span></div>
      {cachedAt && (!online || error) ? (
        <p className="hint">
          项目列表来自本机 · 上次更新 {new Date(cachedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
        </p>
      ) : null}
      {error && (!cachedAt || online) ? <p className="hint hint--error">{error}</p> : null}
      {loading && projects.length === 0 ? <p className="hint">正在加载…</p> : null}
      {projects.length === 0 && !loading && !error ? (
        <p className="empty">电脑上还没有授权项目。请在电脑管理窗口「添加项目」。</p>
      ) : null}
      <ul className="cardlist project-list">
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className="project-entry"
              onClick={() => onOpenProject(project)}
            >
              <span className="project-glyph"><Icon name="folder" size={20} /></span>
              <span className="project-entry__copy"><strong>{project.name}</strong><small>{summaries[project.id] ? summaries[project.id]!.files ? `已缓存 ${summaries[project.id]!.files} 个正文文件` : '尚未缓存正文' : Object.hasOwn(summaries, project.id) ? '离线情况读取失败' : '正在读取离线情况'}{recents.find((v) => v.project.id === project.id) ? ` · ${new Date(recents.find((v) => v.project.id === project.id)!.openedAt).toLocaleDateString('zh-CN')} 看过` : ''}</small></span>
              <Icon name="chevron" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <p className="project-assurance"><Icon name="shield" size={15} />你的代码，只在你的设备之间。</p>
      <div className="project-motto" aria-hidden="true">read.<span>think.</span><span>make.</span></div>
    </section>
  );
}
