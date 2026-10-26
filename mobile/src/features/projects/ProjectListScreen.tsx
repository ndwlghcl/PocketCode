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

interface Props {
  client: PocketCodeClient | null;
  paired: boolean;
  online: boolean;
  /** 定时连接检查完成后后台更新，客户端本身按凭据复用。 */
  lastProbe?: ProbeResult | null;
  onOpenProject: (project: ProjectSummary) => void;
}

/**
 * 项目列表（S2c 真机反馈修订）：缓存秒开——先渲染本地缓存，再后台刷新。
 */
export function ProjectListScreen({ client, paired, online, lastProbe, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      <div className="section-label"><span>已授权项目</span><span>{String(projects.length).padStart(2, '0')}</span></div>
      {cachedAt && (!online || error) ? (
        <p className="hint">
          离线可读 · 最后同步 {new Date(cachedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
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
              <span className="project-entry__copy"><strong>{project.name}</strong><small>快照 #{project.revision}{cachedAt ? ' · 本地缓存' : ' · 电脑授权'}</small></span>
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
