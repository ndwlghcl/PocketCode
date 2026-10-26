import { Icon } from '../../ui/Icon';
import { useCallback, useRef, useState } from 'react';

import type { FileContentResponse, ProjectSummary, SearchFileMatches } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { searchCachedFiles } from '../../storage/cachedSearch';
import { loadCachedFile, saveCachedFile } from '../../storage/cacheStore';

interface Props {
  client: PocketCodeClient | null;
  project: ProjectSummary;
  online: boolean;
  revoked: boolean;
  onBack: () => void;
  onOpenFile: (
    data: FileContentResponse,
    meta: { fromCache?: boolean; cachedAt?: string } | undefined,
    line: number,
  ) => void;
}

interface Results {
  source: 'server' | 'cache';
  query: string;
  totalMatches: number;
  truncated: boolean;
  matches: SearchFileMatches[];
  cachedAt: string | null;
}

/** 搜索结果跨"查看文件后返回"保留：结果存在模块级（项目+关键词命中时复用）。 */
let lastResults: { projectId: string; results: Results } | null = null;

/**
 * 项目搜索页（S4b）：在线搜电脑（服务端全文搜索）；离线自动退化为搜索
 * 本机已缓存文件并明确标注"来自缓存"（PRD §4.1）。点结果行 → 打开文件
 * 并定位到该行。
 */
export function SearchScreen({ client, project, online, revoked, onBack, onOpenFile }: Props) {
  const [query, setQuery] = useState(lastResults?.projectId === project.id ? lastResults.results.query : '');
  const [results, setResults] = useState<Results | null>(
    lastResults?.projectId === project.id ? lastResults.results : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const openingRef = useRef<string | null>(null);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || searching) return;
    setSearching(true);
    setError(null);
    try {
      if (online && client && !revoked) {
        const response = await client.searchProject(project.id, trimmed);
        const next: Results = {
          source: 'server',
          query: response.query,
          totalMatches: response.total_matches,
          truncated: response.truncated,
          matches: response.matches,
          cachedAt: null,
        };
        setResults(next);
        lastResults = { projectId: project.id, results: next };
      } else {
        const cached = await searchCachedFiles(project.id, trimmed);
        const next: Results = {
          source: 'cache',
          query: cached.query,
          totalMatches: cached.totalMatches,
          truncated: cached.truncated,
          matches: cached.matches,
          cachedAt: cached.cachedAt,
        };
        setResults(next);
        lastResults = { projectId: project.id, results: next };
      }
    } catch (cause) {
      setResults(null);
      lastResults = null;
      setError(cause instanceof PocketCodeError ? cause.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  }, [client, online, project.id, revoked, query, searching]);

  const openAt = async (path: string, line: number) => {
    if (!client || openingRef.current) return;
    openingRef.current = path;
    setError(null);
    try {
      let data: FileContentResponse | null = null;
      let meta: { fromCache?: boolean; cachedAt?: string } | undefined;
      if (online && !revoked) {
        try {
          data = await client.readFile(project.id, path);
          void saveCachedFile(project.id, data);
        } catch {
          data = null;
        }
      }
      if (!data) {
        const cached = await loadCachedFile(project.id, path);
        if (cached) {
          data = cached.data;
          meta = { fromCache: true, cachedAt: cached.fetchedAt };
        }
      }
      if (!data) {
        setError('无法打开该文件：当前离线，且没有本地缓存。');
        return;
      }
      onOpenFile(data, meta, line);
    } finally {
      openingRef.current = null;
    }
  };

  const offlineNotice =
    results?.source === 'cache'
      ? `离线模式：结果只覆盖本机已缓存的文件` +
        (results.cachedAt
          ? `（缓存同步于 ${results.cachedAt.slice(0, 19).replace('T', ' ')}）`
          : '')
      : null;

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          <Icon name="back" size={20} /><span className="visually-hidden">返回目录</span>
        </button>
        <div className="navrow__stack">
          <span className="navrow__title">搜索 · {project.name}</span>
          <span className="navrow__meta">
            {online && !revoked ? '搜索电脑上的全部文件' : '离线：只搜本机已缓存文件'}
          </span>
        </div>
      </div>
      <input
        className="field__input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void runSearch();
        }}
        placeholder="搜索关键词（大小写不敏感）"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="btnrow">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void runSearch()}
          disabled={searching || !query.trim()}
        >
          {searching ? '搜索中…' : '搜索'}
        </button>
      </div>
      {offlineNotice ? <p className="hint">⚠ {offlineNotice}</p> : null}
      {results?.truncated ? (
        <p className="hint hint--error">⚠ 结果过多已截断（只显示部分匹配），可换更具体的关键词。</p>
      ) : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      {results && !error ? (
        <p className="hint">
          「{results.query}」共 {results.totalMatches} 处匹配（{results.matches.length} 个文件）
        </p>
      ) : null}
      <ul className="cardlist">
        {(results?.matches ?? []).map((fileMatches) => (
          <li key={fileMatches.path}>
            <div className="searchfile">
              <p className="searchfile__path">{fileMatches.path}</p>
              <ul className="searchfile__lines">
                {fileMatches.lines.map((hit) => (
                  <li key={hit.line}>
                    <button
                      type="button"
                      className="searchfile__line"
                      onClick={() => void openAt(fileMatches.path, hit.line)}
                    >
                      <span className="searchfile__lineno">{hit.line}</span>
                      <span className="searchfile__text">{hit.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
