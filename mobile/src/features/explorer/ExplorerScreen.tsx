import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FileContentResponse, ManifestNode, ProjectSummary } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import {
  loadCachedFile,
  loadCachedManifest,
  saveCachedFile,
  saveCachedManifest,
} from '../../storage/cacheStore';
import { restoreWindowScroll, saveWindowScroll } from '../../app/scrollMemory';
import { sortEntries } from './sortEntries';

/** 文件夹展开状态按项目记忆：从文件返回目录时保持上次展开的样子。
 *  语义：记录“已展开”的目录；不在集合中 = 收起（默认全部收起，用户要求）。 */
const expandedMemory = new Map<string, ReadonlySet<string>>();

interface Props {
  client: PocketCodeClient | null;
  project: ProjectSummary;
  online: boolean;
  /** 授权被撤销：本地缓存内容也不得再展示。 */
  revoked: boolean;
  onBack: () => void;
  onOpenFile: (data: FileContentResponse, meta?: { fromCache?: boolean; cachedAt?: string }) => void;
  /** 打开项目全文搜索页（S4b）。 */
  onOpenSearch: () => void;
  /** 打开项目 Git 状态页（S4e）。 */
  onOpenGit: () => void;
  /** 打开多文件分享页（S4f）。 */
  onOpenShare: () => void;
}

/** 文件名过滤：保留名字命中的文件；目录其子树内有命中则保留。 */
function filterTree(children: ManifestNode[], needle: string): ManifestNode[] {
  const result: ManifestNode[] = [];
  for (const node of children) {
    if (node.type === 'file') {
      if (node.name.toLowerCase().includes(needle)) result.push(node);
    } else {
      const hitChildren = filterTree(node.children, needle);
      if (hitChildren.length > 0 || node.name.toLowerCase().includes(needle)) {
        result.push({ ...node, children: hitChildren });
      }
    }
  }
  return result;
}

interface Notice {
  kind: 'ok' | 'bad';
  text: string;
}

/**
 * 目录浏览（S3c 增补）：在 S2c 展开收起 + 缓存秒开的基础上，
 * 增加新建文件/文件夹与删除（进电脑端回收区）入口。
 * 写操作仅在线可用；删除必须确认，防误触（PRD §5.2）。
 */
export function ExplorerScreen({
  client,
  project,
  online,
  revoked,
  onBack,
  onOpenFile,
  onOpenSearch,
  onOpenGit,
  onOpenShare,
}: Props) {
  const [rootChildren, setRootChildren] = useState<ManifestNode[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => expandedMemory.get(project.id) ?? new Set(),
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  /** 文件名过滤（本地即时，PRD §4.1 文件名搜索）。 */
  const [nameFilter, setNameFilter] = useState('');
  const scrollRestored = useRef(false);
  const scrollKey = `explorer:${project.id}`;

  // 滚动位置记忆：持续记录；返回进入本页后，列表渲染完成即恢复到上次位置
  useEffect(() => {
    const onScroll = () => saveWindowScroll(scrollKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      saveWindowScroll(scrollKey);
    };
  }, [scrollKey]);

  useEffect(() => {
    if (rootChildren && !scrollRestored.current) {
      scrollRestored.current = true;
      restoreWindowScroll(scrollKey);
    }
  }, [rootChildren, scrollKey]);

  // ---- 目录加载：缓存秒开 + 后台网络刷新；新建/删除成功后也走这里同步 ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await loadCachedManifest(project.id);
      if (cancelled) return;
      if (cached) {
        setRootChildren(cached.root.children);
        setFromCache(true);
      }
      if (!client) return;
      setError(null);
      try {
        const manifest = await client.getManifest(project.id);
        if (cancelled) return;
        setRootChildren(manifest.root.children);
        await saveCachedManifest(project.id, manifest);
        if (!cancelled) setFromCache(false);
      } catch (cause) {
        if (cancelled) return;
        const fallback = await loadCachedManifest(project.id);
        if (fallback) {
          setRootChildren(fallback.root.children);
          setFromCache(true);
        }
        setError(
          cause instanceof PocketCodeError && cause.code !== 'OFFLINE'
            ? cause.message
            : '无法获取最新目录，显示的是本地缓存',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, project.id, online]);

  const refreshManifest = async (): Promise<boolean> => {
    if (!client) return false;
    try {
      const manifest = await client.getManifest(project.id);
      setRootChildren(manifest.root.children);
      await saveCachedManifest(project.id, manifest);
      setFromCache(false);
      return true;
    } catch (cause) {
      setError(
        cause instanceof PocketCodeError && cause.code !== 'OFFLINE'
          ? cause.message
          : '目录刷新失败，当前显示可能已过期',
      );
      return false;
    }
  };

  const expandDir = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      next.add(path);
      expandedMemory.set(project.id, next);
      return next;
    });
  };

  const createEntry = async (type: 'file' | 'dir') => {
    if (!client || revoked || !online || mutationBusy) return;
    const name = window.prompt(
      type === 'file'
        ? '新文件名（可含子路径，如 docs/笔记.md）'
        : '新文件夹名（可含子路径，如 docs/接口草案）',
      type === 'file' ? '新文件.txt' : '新文件夹',
    );
    if (name === null) return;
    const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return;
    setNotice(null);
    setMutationBusy(true);
    try {
      await client.createEntry(project.id, { path: trimmed, type });
      // 新条目带子路径时展开父目录，让用户立刻看到它
      const parent = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : null;
      if (parent) expandDir(parent);
      setNotice({ kind: 'ok', text: `已创建 ${trimmed}` });
      await refreshManifest();
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof PocketCodeError ? cause.message : '创建失败',
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const trashEntry = async (node: ManifestNode) => {
    if (!client || revoked || !online || mutationBusy) return;
    const confirmed = window.confirm(
      node.type === 'dir'
        ? `把文件夹「${node.name}」移入回收区？\n其中的全部内容会一起移入，之后可在连接页的回收区恢复。`
        : `把文件「${node.name}」移入回收区？\n之后可在连接页的回收区恢复。`,
    );
    if (!confirmed) return;
    setNotice(null);
    setMutationBusy(true);
    try {
      await client.trashEntries(project.id, { paths: [node.path] });
      setNotice({ kind: 'ok', text: `已移入回收区：${node.path}` });
      await refreshManifest();
    } catch (cause) {
      setNotice({
        kind: 'bad',
        text: cause instanceof PocketCodeError ? cause.message : '删除失败',
      });
    } finally {
      setMutationBusy(false);
    }
  };

  const toggle = (path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      expandedMemory.set(project.id, next);
      return next;
    });
  };

  const openFile = async (node: ManifestNode & { type: 'file' }) => {
    if (!client) return;
    if (revoked) {
      setFileError('授权已被电脑撤销，无法读取文件');
      return;
    }
    setFileError(null);
    setFileLoading(node.path);
    const cached = await loadCachedFile(project.id, node.path);

    if (!online) {
      // 离线：直接打开缓存（PRD：打开过的文件离线可看）
      setFileLoading(null);
      if (cached) {
        onOpenFile(cached.data, { fromCache: true, cachedAt: cached.fetchedAt });
      } else {
        setFileError('该文件还没有本地缓存，联网后打开一次即可离线查看');
      }
      return;
    }

    try {
      const data = await client.readFile(project.id, node.path);
      saveCachedFile(project.id, data);
      setFileLoading(null);
      onOpenFile(data);
    } catch (cause) {
      setFileLoading(null);
      if (cached) {
        // 在线但读取失败（电脑休眠等）：回退缓存并明确标注
        onOpenFile(cached.data, { fromCache: true, cachedAt: cached.fetchedAt });
      } else {
        setFileError(cause instanceof PocketCodeError ? cause.message : '读取文件失败');
      }
    }
  };

  const mutationsEnabled = online && !revoked && !mutationBusy;
  const needle = nameFilter.trim().toLowerCase();
  // 过滤模式下全部展开（否则命中藏在收起的目录里看不见）
  const displayChildren =
    rootChildren === null ? null : needle ? filterTree(rootChildren, needle) : rootChildren;

  const renderNodes = (children: ManifestNode[], depth: number): ReactNode[] =>
    sortEntries(children).map((node) => {
      const row = (
        <div className="filelist__row">
          {node.type === 'dir' ? (
            <button
              type="button"
              className="filelist__item"
              style={{ paddingLeft: `${12 + depth * 18}px` }}
              onClick={() => (needle ? null : toggle(node.path))}
            >
              <span className="filelist__icon">
                {needle ? '🔎' : expanded.has(node.path) ? '▾' : '▸'}
              </span>
              <span>{node.name}</span>
            </button>
          ) : (
            <button
              type="button"
              className="filelist__item"
              style={{ paddingLeft: `${12 + depth * 18}px` }}
              onClick={() => void openFile(node)}
            >
              <span className="filelist__icon">{fileLoading === node.path ? '⏳' : '📄'}</span>
              <span>{node.name}</span>
            </button>
          )}
          <button
            type="button"
            className="filelist__delete"
            aria-label={`删除 ${node.name}`}
            onClick={() => void trashEntry(node)}
            disabled={!mutationsEnabled}
          >
            🗑
          </button>
        </div>
      );
      if (node.type === 'dir') {
        const isOpen = needle ? true : expanded.has(node.path);
        return (
          <Fragment key={`dir:${node.path}`}>
            <li>{row}</li>
            {isOpen ? renderNodes(node.children, depth + 1) : null}
          </Fragment>
        );
      }
      return <li key={`file:${node.path}`}>{row}</li>;
    });

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="navrow__title">{project.name}</span>
      </div>
      <div className="btnrow">
        <button
          type="button"
          className="btn"
          onClick={onOpenSearch}
        >
          🔍 搜索
        </button>
        <button type="button" className="btn" onClick={onOpenGit}>
          Git
        </button>
        <button type="button" className="btn" onClick={onOpenShare}>
          分享
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void createEntry('file')}
          disabled={!mutationsEnabled}
        >
          ＋文件
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void createEntry('dir')}
          disabled={!mutationsEnabled}
        >
          ＋夹
        </button>
      </div>
      <input
        className="field__input"
        value={nameFilter}
        onChange={(event) => setNameFilter(event.target.value)}
        placeholder="按文件名过滤（本地即时）"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {notice ? (
        <div className={`result ${notice.kind === 'ok' ? 'result--ok' : 'result--bad'}`}>
          <p className="result__title">
            {notice.kind === 'ok' ? '✔ ' : '✘ '}
            {notice.text}
          </p>
        </div>
      ) : null}
      {fileError ? (
        <div className="result result--bad">
          <p className="result__title">✘ {fileError}</p>
        </div>
      ) : null}
      {fromCache ? <p className="hint">目录来自本地缓存，联网后自动更新</p> : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      {!rootChildren ? <p className="hint">正在读取目录…</p> : null}
      {rootChildren && rootChildren.length === 0 && !needle ? (
        <p className="empty">这个项目目录是空的（或全部内容被过滤）。</p>
      ) : null}
      {rootChildren && needle && displayChildren && displayChildren.length === 0 ? (
        <p className="empty">没有文件名包含「{nameFilter.trim()}」。</p>
      ) : null}
      <ul className="filelist">
        {displayChildren ? renderNodes(displayChildren, 0) : null}
      </ul>
    </section>
  );
}
