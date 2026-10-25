/**
 * 离线全文搜索（S4b）：只搜本机已缓存的文件内容（PRD §4.1——离线搜索
 * 只覆盖已缓存内容，必须标注缓存来源与同步时间）。
 *
 * 直接枚举 cacheStore 的 pc.cache.file.* 键，逐份读内容做大小写不敏感
 * 子串匹配；限额与服务端一致（单文件 20 条 / 总 200 条 / 扫描 3000 个）。
 */

import type { SearchFileMatches, SearchLineMatch } from '../api/types';
import { diskStorage, type KVStorage } from '../native';

const FILE_PREFIX = 'pc.cache.file.';
const MAX_MATCHES_PER_FILE = 20;
const MAX_TOTAL_MATCHES = 200;
const MAX_SCAN_FILES = 3000;

export interface CachedSearchResult {
  query: string;
  totalMatches: number;
  truncated: boolean;
  matches: SearchFileMatches[];
  /** 缓存里最新的同步时间（用于"来自缓存"标注）；无缓存文件时为 null。 */
  cachedAt: string | null;
}

function parseFileKey(key: string, projectId: string): string | null {
  const prefix = `${FILE_PREFIX}${projectId}.`;
  if (!key.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(key.slice(prefix.length));
  } catch {
    return null;
  }
}

export async function searchCachedFiles(
  projectId: string,
  rawQuery: string,
  storage: KVStorage = diskStorage,
): Promise<CachedSearchResult> {
  const query = rawQuery.trim();
  const needle = query.toLowerCase();
  const result: CachedSearchResult = {
    query,
    totalMatches: 0,
    truncated: false,
    matches: [],
    cachedAt: null,
  };
  if (!needle) return result;

  let keys: string[] = [];
  try {
    keys = (await storage.keys(FILE_PREFIX)).sort();
  } catch {
    return result;
  }

  for (const key of keys) {
    if (result.truncated) break;
    const path = parseFileKey(key, projectId);
    if (path === null) continue;
    if (result.matches.length >= MAX_SCAN_FILES) {
      result.truncated = true;
      break;
    }
    let content: string | null = null;
    let fetchedAt: string | null = null;
    try {
      const raw = await storage.get(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        fetchedAt?: string;
        data?: { content?: unknown };
      };
      if (typeof parsed.data?.content === 'string') content = parsed.data.content;
      if (typeof parsed.fetchedAt === 'string') fetchedAt = parsed.fetchedAt;
    } catch {
      continue;
    }
    if (content === null) continue;
    if (fetchedAt && (!result.cachedAt || fetchedAt > result.cachedAt)) {
      result.cachedAt = fetchedAt;
    }

    const lines: SearchLineMatch[] = [];
    const contentLines = content.split('\n');
    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].toLowerCase().includes(needle)) {
        lines.push({ line: i + 1, text: contentLines[i].replace(/\r$/, '') });
        if (lines.length >= MAX_MATCHES_PER_FILE) {
          result.truncated = true;
          break;
        }
      }
    }
    if (lines.length > 0) {
      if (result.totalMatches + lines.length > MAX_TOTAL_MATCHES) {
        result.truncated = true;
        break;
      }
      result.matches.push({ path, lines } satisfies SearchFileMatches);
      result.totalMatches += lines.length;
      if (result.totalMatches >= MAX_TOTAL_MATCHES) result.truncated = true;
    }
  }
  return result;
}
