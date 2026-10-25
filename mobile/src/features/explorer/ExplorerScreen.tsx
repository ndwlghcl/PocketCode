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
}

/**
 * 目录浏览（S2c 真机反馈修订）：
 * - 文件夹可点击展开/收起（默认收起），不再是全展开的扁平长列表；
 * - 排序仍为文件夹前、文件后、各组名称排序；
 * - 缓存秒开：先渲染上次缓存，再后台刷新网络数据。
 */
export function ExplorerScreen({ client, project, online, revoked, onBack, onOpenFile }: Props) {
  const [rootChildren, setRootChildren] = useState<ManifestNode[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => expandedMemory.get(project.id) ?? new Set(),
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<string | null>(null);
  const scrollRestored = useRef(false);
  const scrollKey = `explorer:${project.id}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 缓存秒开：先渲染本地缓存，再请求网络更新
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
        setFromCache(false);
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

  const renderNodes = (children: ManifestNode[], depth: number): ReactNode[] =>
    sortEntries(children).map((node) => {
      if (node.type === 'dir') {
        const isOpen = expanded.has(node.path);
        return (
          <Fragment key={`dir:${node.path}`}>
            <li>
              <button
                type="button"
                className="filelist__item"
                style={{ paddingLeft: `${12 + depth * 18}px` }}
                onClick={() => toggle(node.path)}
              >
                <span className="filelist__icon">{isOpen ? '▾' : '▸'}</span>
                <span>{node.name}</span>
              </button>
            </li>
            {isOpen ? renderNodes(node.children, depth + 1) : null}
          </Fragment>
        );
      }
      return (
        <li key={`file:${node.path}`}>
          <button
            type="button"
            className="filelist__item"
            style={{ paddingLeft: `${12 + depth * 18}px` }}
            onClick={() => void openFile(node)}
          >
            <span className="filelist__icon">{fileLoading === node.path ? '⏳' : '📄'}</span>
            <span>{node.name}</span>
          </button>
        </li>
      );
    });

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          ‹ 返回
        </button>
        <span className="navrow__title">{project.name}</span>
      </div>
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
      {rootChildren && rootChildren.length === 0 ? (
        <p className="empty">这个项目目录是空的（或全部内容被过滤）。</p>
      ) : null}
      <ul className="filelist">{rootChildren ? renderNodes(rootChildren, 0) : null}</ul>
    </section>
  );
}
