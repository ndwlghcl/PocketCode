import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import {
  loadCachedProjects,
  saveCachedProjects,
} from '../../storage/cacheStore';
import { restoreWindowScroll, saveWindowScroll } from '../../app/scrollMemory';

interface Props {
  client: PocketCodeClient | null;
  paired: boolean;
  online: boolean;
  onOpenProject: (project: ProjectSummary) => void;
}

/**
 * 项目列表（S2c 真机反馈修订）：缓存秒开——先渲染本地缓存，再后台刷新。
 */
export function ProjectListScreen({ client, paired, online, onOpenProject }: Props) {
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
  }, [client, paired, online]);

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
        <h1 className="screen__title">项目</h1>
        <p className="empty">
          尚未配对电脑。点右上角「⚙ 连接」扫码配对。
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1 className="screen__title">项目</h1>
      {cachedAt ? (
        <p className="hint">
          来自本地缓存（{cachedAt.slice(0, 19).replace('T', ' ')}），联网后自动更新
        </p>
      ) : null}
      {error ? <p className="hint hint--error">{error}</p> : null}
      {loading && projects.length === 0 ? <p className="hint">正在加载…</p> : null}
      {projects.length === 0 && !loading && !error ? (
        <p className="empty">电脑上还没有授权项目。请在电脑管理窗口「添加项目」。</p>
      ) : null}
      <ul className="cardlist">
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className="cardlist__item"
              onClick={() => onOpenProject(project)}
            >
              <span className="cardlist__name">{project.name}</span>
              <span className="cardlist__meta">快照 #{project.revision}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
