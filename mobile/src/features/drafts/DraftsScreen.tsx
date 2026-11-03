import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProjectSummary } from '../../api/types';
import { PocketCodeClient } from '../../api/client';
import {
  clearAllDrafts,
  listAllDrafts,
  removeDraft,
  setActiveDraft,
  type DraftListItem,
  type FileDraft,
  restoreDraftBackup,
  type DraftBackup,
} from '../../storage/draftStore';
import {
  loadCachedProjects,
  saveCachedProjects,
} from '../../storage/cacheStore';
import { CodeEditor } from '../editor/CodeEditor';
import { Icon } from '../../ui/Icon';
import { ActionSheet, IconButton, MenuItem } from '../../ui/Controls';
import { shareText, shareArchive } from '../sharing/share';
import { buildDraftBackup, parseDraftBackup } from './draftBackup';
import { ConflictDiff } from '../explorer/ConflictDiff';

interface Props {
  client: PocketCodeClient | null;
  online: boolean;
  onOpenDraft: (draft: FileDraft) => void;
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
  const [toolsOpen, setToolsOpen] = useState(false);
  const backupInput = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<DraftBackup | null>(null);
  const [compare, setCompare] = useState<{ first: FileDraft; second: FileDraft } | null>(null);
  const [compareFirst, setCompareFirst] = useState<FileDraft | null>(null);

  const backupAll = async () => {
    if (busy) return; setBusy(true); setError(null); setNotice(null);
    try {
      const backup = await buildDraftBackup();
      const result = await shareArchive(backup.name, backup.bytes);
      if (!result.ok) throw new Error(result.message ?? '备份导出失败');
      if (!result.cancelled) setNotice(result.downloaded ? `已下载 ${backup.count} 份草稿的备份` : '已打开备份分享面板，请选择保存位置并确认保存');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '备份失败，草稿保留'); }
    finally { setBusy(false); }
  };
  const chooseBackup = async (file: File) => {
    if (busy) return; setBusy(true); setError(null); setNotice(null);
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error('备份文件超过 16 MiB 上限');
      setPendingBackup(parseDraftBackup(new Uint8Array(await file.arrayBuffer())));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '备份读取失败'); }
    finally { setBusy(false); }
  };
  const restoreAll = async () => {
    if (!pendingBackup || busy) return; setBusy(true); setError(null);
    try { const result = await restoreDraftBackup(pendingBackup); setPendingBackup(null); await reload(); setNotice(`已恢复 ${result.restored} 份草稿，跳过 ${result.skipped} 份相同内容；原有版本保留。`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败，原草稿保留'); }
    finally { setBusy(false); }
  };

  const loadProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    try {
      if (client && online) {
        const response = await client.listProjects();
        await saveCachedProjects(response.projects);
        return response.projects;
      }
    } catch {
      // 在线获取失败则退缓存
    }
    const cached = await loadCachedProjects();
    return cached?.projects ?? [];
  }, [client, online]);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const errors: string[] = [];
      const allDrafts = await listAllDrafts(undefined, (message) => errors.push(message));
      setItems(allDrafts);
      setError(errors.length ? `${errors.length} 个文件的草稿无法读取，以下仅显示可读取部分。${errors.slice(0, 3).join(' ')}` : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取草稿箱，请重试');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 项目名称只是展示信息，电脑请求慢或失败都不能阻塞本地草稿列表。
  useEffect(() => {
    let cancelled = false;
    void loadProjects().then((projects) => {
      if (!cancelled) setProjectNames(Object.fromEntries(projects.map((project) => [project.id, project.name])));
    });
    return () => { cancelled = true; };
  }, [loadProjects]);

  const openDraft = async (item: DraftListItem) => {
    setError(null);
    setBusy(true);
    try {
      const stored = await setActiveDraft(item.projectId, item.path, item.draft.id);
      const fresh = stored.drafts.find((draft) => draft.id === item.draft.id)!;
      onOpenDraft({ ...fresh, projectName: fresh.projectName ?? projectNames[item.projectId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '草稿读取失败，未打开');
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
    setNotice(null); setError(null);
    try {
      await removeDraft(item.projectId, item.path, item.draft.id);
      await reload();
      setNotice('草稿已删除');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const clearEverything = async () => {
    if (!window.confirm('清空全部草稿？\n所有文件的所有草稿都会删除，不可恢复。')) {
      return;
    }
    setBusy(true);
    setNotice(null); setError(null);
    try {
      await clearAllDrafts();
      await reload();
      setNotice('草稿箱已清空');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清理未全部完成，请刷新检查');
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
      <header className="page-intro page-heading-row"><div><p className="eyebrow">想法，先留在这里</p><h1>草稿箱<span>.</span></h1></div><IconButton icon="more" label="草稿箱操作" onClick={() => setToolsOpen(true)} /></header>
      <p className="project-assurance"><Icon name="shield" size={16} />保存在这台设备，离线也能翻阅。</p>
      <input ref={backupInput} className="visually-hidden" type="file" accept=".zip,.json,application/zip,application/json" aria-label="选择草稿备份" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void chooseBackup(file); }} />
      {busy && <p className="hint" role="status">正在处理草稿，请稍候…</p>}
      {compareFirst && <p className="hint">已选「{compareFirst.name}」，请在同一文件的另一份草稿上点击“与所选版本比较”。<button type="button" className="draftcard__action" onClick={() => setCompareFirst(null)}>取消选择</button></p>}
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
      {items === null ? (
        <p className="hint">{error ? '草稿未能完整读取，请在菜单中重试刷新；原数据保留。' : '正在读取草稿…'}</p>
      ) : items.length === 0 && error ? <p className="hint">未能读取草稿，请重试刷新。原数据保留。</p> : items.length === 0 ? (
        <div className="empty"><Icon name="drafts" size={30} /><p>留一点空间给新想法。</p><span>编辑文件时，草稿会在这里等你。</span></div>
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
                  <span className="draftcard__name"><Icon name="drafts" size={18} /> {item.draft.name}</span>
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
                  {item.draft.projectName ?? projectNames[item.projectId] ?? '来源项目不可用'} ·{' '}
                  {item.draft.savedAt.slice(0, 19).replace('T', ' ')}
                </p>
                <p className="cardlist__meta draftcard__path">{item.path}</p>
                <p className="draft-save-state"><Icon name="check" size={13} />已保存在本机</p>
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
                      <button type="button" className="draftcard__action" onClick={() => { void shareText(`草稿 · ${item.draft.name}`, item.draft.content).then((result) => { if (!result.ok) setError(result.message ?? '导出失败'); }); }}>导出草稿</button>
                    </div>
                  </>
                ) : null}
                <div className="draftcard__row">
                  <button type="button" className="draftcard__action" disabled={busy} onClick={() => {
                    if (compareFirst && compareFirst.id !== item.draft.id && compareFirst.projectId === item.projectId && compareFirst.path === item.path) { setCompare({ first: compareFirst, second: item.draft }); setCompareFirst(null); }
                    else setCompareFirst(item.draft);
                  }}>{compareFirst && compareFirst.id !== item.draft.id && compareFirst.projectId === item.projectId && compareFirst.path === item.path ? '与所选版本比较' : '选择作比较'}</button>
                  <button
                    type="button"
                    className="draftcard__action draftcard__action--primary"
                    onClick={() => void openDraft(item)}
                    disabled={busy}
                  >
                    去编辑
                  </button>
                  <button
                    type="button"
                    className="draftcard__action draftcard__action--danger"
                    onClick={() => void deleteItem(item)}
                    disabled={busy}
                  >
                    <Icon name="trash" size={16} /><span>删除</span>
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {compare && <ConflictDiff computer={compare.first.content} draft={compare.second.content} title="草稿版本对比" beforeLabel={compare.first.name} afterLabel={compare.second.name} onClose={() => setCompare(null)} />}
      {pendingBackup && <ActionSheet title="恢复草稿备份" onClose={() => { if (!busy) setPendingBackup(null); }}><p>备份时间：{new Date(pendingBackup.createdAt).toLocaleString('zh-CN')}</p><p>共 {pendingBackup.drafts.length} 份草稿，来自 {new Set(pendingBackup.drafts.map((d) => `${d.projectId}:${d.path}`)).size} 个文件。</p><p className="hint">恢复只追加版本，同名草稿会保留；完全相同的版本跳过。不会写入电脑文件。</p><button type="button" className="btn btn--primary" disabled={busy} onClick={() => void restoreAll()}>确认恢复</button></ActionSheet>}
      {toolsOpen && <ActionSheet title="草稿箱操作" onClose={() => setToolsOpen(false)}><MenuItem icon="download" disabled={busy} onClick={() => { setToolsOpen(false); void backupAll(); }}>备份全部草稿</MenuItem><MenuItem icon="drafts" disabled={busy} onClick={() => { setToolsOpen(false); backupInput.current?.click(); }}>从备份恢复</MenuItem><MenuItem icon="refresh" disabled={busy} onClick={() => { setToolsOpen(false); void reload(); }}>刷新草稿</MenuItem><MenuItem icon="trash" danger disabled={busy || !items?.length} onClick={() => { setToolsOpen(false); void clearEverything(); }}>清空全部草稿</MenuItem></ActionSheet>}
    </section>
  );
}
