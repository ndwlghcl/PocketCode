import { useCallback, useEffect, useState } from 'react';

import type { FileContentResponse, ProjectSummary } from '../../api/types';
import { PocketCodeClient } from '../../api/client';
import {
  clearAllDrafts,
  listAllDrafts,
  removeDraft,
  setActiveDraft,
  type DraftListItem,
} from '../../storage/draftStore';
import {
  loadCachedFile,
  loadCachedProjects,
  saveCachedFile,
  saveCachedProjects,
} from '../../storage/cacheStore';
import { CodeEditor } from '../editor/CodeEditor';

interface Props {
  client: PocketCodeClient | null;
  online: boolean;
  /** 用户点「去编辑」并成功取到文件内容后，由根布局负责路由。 */
  onOpenDraft: (
    project: ProjectSummary,
    data: FileContentResponse,
    meta?: { fromCache?: boolean; cachedAt?: string },
  ) => void;
}

/**
 * 草稿箱（S4a2，用户反馈新增）：跨项目/跨文件集中管理所有本地草稿。
 *
 * 草稿定位（PRD §6.2 + 用户澄清）：不只是"待同步的修改"，还是修改版本
 * 与灵感的记录——保存到电脑后草稿保留，删除/清空全部由用户在这里手动做。
 */
export function DraftsScreen({ client, online, onOpenDraft }: Props) {
  const [items, setItems] = useState<DraftListItem[] | null>(null);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    try {
      if (client) {
        const response = await client.listProjects();
        await saveCachedProjects(response.projects);
        return response.projects;
      }
    } catch {
      // 在线获取失败则退缓存
    }
    const cached = await loadCachedProjects();
    return cached?.projects ?? [];
  }, [client]);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const [allDrafts, projects] = await Promise.all([listAllDrafts(), loadProjects()]);
      setItems(allDrafts);
      const names: Record<string, string> = {};
      for (const project of projects) names[project.id] = project.name;
      setProjectNames(names);
      setError(null);
    } finally {
      setBusy(false);
    }
  }, [loadProjects]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openDraft = async (item: DraftListItem) => {
    if (!client) return;
    setError(null);
    setBusy(true);
    try {
      // 打开后 FileScreen 会按 activeId 恢复这份草稿
      await setActiveDraft(item.projectId, item.path, item.draft.id);
      const projects = await loadProjects();
      const project = projects.find((entry) => entry.id === item.projectId);
      if (!project) {
        setError('找不到草稿所属的项目（可能已被电脑端移除授权）');
        return;
      }
      let data: FileContentResponse | null = null;
      let meta: { fromCache?: boolean; cachedAt?: string } | undefined;
      if (online) {
        try {
          data = await client.readFile(item.projectId, item.path);
          void saveCachedFile(item.projectId, data);
        } catch {
          data = null;
        }
      }
      if (!data) {
        const cached = await loadCachedFile(item.projectId, item.path);
        if (cached) {
          data = cached.data;
          meta = { fromCache: true, cachedAt: cached.fetchedAt };
        }
      }
      if (!data) {
        setError('无法加载文件内容：当前离线，且该文件没有本地缓存。');
        return;
      }
      onOpenDraft(project, data, meta);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (item: DraftListItem) => {
    if (
      !window.confirm(
        `删除草稿「${item.draft.name}」？\n其内容将丢失（不影响电脑上的文件）。`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await removeDraft(item.projectId, item.path, item.draft.id);
      await reload();
      setNotice('草稿已删除');
    } finally {
      setBusy(false);
    }
  };

  const clearEverything = async () => {
    if (!window.confirm('清空全部草稿？\n所有文件的所有草稿都会删除，不可恢复。')) {
      return;
    }
    setBusy(true);
    try {
      await clearAllDrafts();
      await reload();
      setNotice('草稿箱已清空');
    } finally {
      setBusy(false);
    }
  };

  const copyDraft = async (item: DraftListItem) => {
    try {
      await navigator.clipboard.writeText(item.draft.content);
      setNotice(`已复制「${item.draft.name}」全文`);
    } catch {
      setError('复制失败：当前环境不允许访问剪贴板');
    }
  };

  return (
    <section>
      <h1 className="screen__title">草稿箱</h1>
      <p className="hint">
        保存到电脑后草稿仍保留在这里——它们是修改版本和灵感的记录，由你手动管理。
      </p>
      {notice ? (
        <div className="result result--ok">
          <p className="result__title">✔ {notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      <div className="btnrow">
        <button type="button" className="btn" onClick={() => void reload()} disabled={busy}>
          {busy ? '正在刷新…' : '刷新'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void clearEverything()}
          disabled={busy || !items || items.length === 0}
        >
          清空全部
        </button>
      </div>
      {items === null ? (
        <p className="hint">正在读取草稿…</p>
      ) : items.length === 0 ? (
        <p className="empty">草稿箱是空的。打开文件进入编辑后会自动生成草稿。</p>
      ) : (
        <p className="hint">共 {items.length} 份草稿</p>
      )}
      <ul className="cardlist">
        {(items ?? []).map((item) => {
          const expanded = expandedId === item.draft.id;
          return (
            <li key={item.draft.id}>
              <div className="draftcard">
                <div className="draftcard__head">
                  <span className="draftcard__name">{item.draft.name}</span>
                  <button
                    type="button"
                    className="draftcard__action"
                    onClick={() => setExpandedId(expanded ? null : item.draft.id)}
                  >
                    {expanded ? '收起' : '查看'}
                  </button>
                </div>
                <p className="cardlist__meta">
                  {item.path.split('/').pop()} ·{' '}
                  {projectNames[item.projectId] ?? '未知项目'} ·{' '}
                  {item.draft.savedAt.slice(0, 19).replace('T', ' ')}
                </p>
                <p className="cardlist__meta draftcard__path">{item.path}</p>
                {expanded ? (
                  <>
                    <CodeEditor
                      className="draftcard__preview"
                      doc={item.draft.content}
                      readOnly
                      fileName={item.path}
                      wrap
                    />
                    <div className="draftcard__row">
                      <button
                        type="button"
                        className="draftcard__action"
                        onClick={() => void copyDraft(item)}
                      >
                        复制全文
                      </button>
                    </div>
                  </>
                ) : null}
                <div className="draftcard__row">
                  <button
                    type="button"
                    className="draftcard__action draftcard__action--primary"
                    onClick={() => void openDraft(item)}
                    disabled={busy || !client}
                  >
                    去编辑
                  </button>
                  <button
                    type="button"
                    className="draftcard__action draftcard__action--danger"
                    onClick={() => void deleteItem(item)}
                    disabled={busy}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
