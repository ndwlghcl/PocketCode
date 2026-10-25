/**
 * 草稿箱（S3b）：每个文件的本地未保存修改。
 *
 * 规则（PRD §6.2）：
 * - 每个文件支持多份命名草稿（如「异常处理实验 A」「随便改着玩」）；
 * - 草稿独立于文件缓存，保存到电脑成功后清除对应草稿；
 * - 草稿记录 baseVersion（编辑所基于的电脑版本），保存冲突检测依赖它；
 * - 存储走原生文件 KV（可靠落盘，不使用可能被系统清理的 WebView
 *   localStorage）；键前缀 pc.draft.* 与缓存 pc.cache.* 分离，互不影响。
 */

import { diskStorage, type KVStorage } from '../native';

const DRAFT_PREFIX = 'pc.draft.';

export interface FileDraft {
  id: string;
  name: string;
  path: string;
  projectId: string;
  content: string;
  /** 编辑所基于的电脑文件版本；保存时作为 base_version。 */
  baseVersion: string;
  savedAt: string;
}

export interface StoredDrafts {
  activeId: string | null;
  drafts: FileDraft[];
}

function storageKey(projectId: string, path: string): string {
  return `${DRAFT_PREFIX}${projectId}.${encodeURIComponent(path)}`;
}

function isValidDraft(value: unknown): value is FileDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<FileDraft>;
  return (
    typeof draft.id === 'string' &&
    draft.id.length > 0 &&
    typeof draft.name === 'string' &&
    typeof draft.path === 'string' &&
    typeof draft.projectId === 'string' &&
    typeof draft.content === 'string' &&
    typeof draft.baseVersion === 'string' &&
    draft.baseVersion.startsWith('sha256:') &&
    typeof draft.savedAt === 'string'
  );
}

export async function loadDrafts(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  try {
    const raw = await storage.get(storageKey(projectId, path));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredDrafts>;
      if (Array.isArray(parsed.drafts)) {
        const drafts = parsed.drafts.filter(isValidDraft);
        const activeId =
          typeof parsed.activeId === 'string' &&
          drafts.some((draft) => draft.id === parsed.activeId)
            ? parsed.activeId
            : (drafts[0]?.id ?? null);
        return { activeId, drafts };
      }
    }
  } catch {
    // 损坏/不可用：按无草稿处理，绝不阻塞编辑
  }
  return { activeId: null, drafts: [] };
}

async function saveDrafts(
  projectId: string,
  path: string,
  stored: StoredDrafts,
  storage: KVStorage = diskStorage,
): Promise<void> {
  await storage.set(storageKey(projectId, path), JSON.stringify(stored));
}

export function newDraftId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 新建或更新草稿并设为活动草稿。 */
export async function upsertDraft(
  projectId: string,
  path: string,
  draft: FileDraft,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  const stored = await loadDrafts(projectId, path, storage);
  const next: StoredDrafts = {
    activeId: draft.id,
    drafts: [draft, ...stored.drafts.filter((existing) => existing.id !== draft.id)],
  };
  await saveDrafts(projectId, path, next, storage);
  return next;
}

export async function setActiveDraft(
  projectId: string,
  path: string,
  id: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  const stored = await loadDrafts(projectId, path, storage);
  const next: StoredDrafts = { ...stored, activeId: id };
  await saveDrafts(projectId, path, next, storage);
  return next;
}

/** 删除一份草稿；若删的是活动草稿则顺延到最近一份。 */
export async function removeDraft(
  projectId: string,
  path: string,
  id: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  const stored = await loadDrafts(projectId, path, storage);
  const drafts = stored.drafts.filter((draft) => draft.id !== id);
  const next: StoredDrafts = {
    activeId: stored.activeId === id ? (drafts[0]?.id ?? null) : stored.activeId,
    drafts,
  };
  await saveDrafts(projectId, path, next, storage);
  return next;
}

/** 重命名一份草稿（S4a：内容与活动态都不变，只改名字）。 */
export async function renameDraft(
  projectId: string,
  path: string,
  id: string,
  name: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts | null> {
  const stored = await loadDrafts(projectId, path, storage);
  const target = stored.drafts.find((draft) => draft.id === id);
  if (!target) return null;
  const trimmed = name.trim();
  if (!trimmed) return stored;
  const next: StoredDrafts = {
    ...stored,
    drafts: stored.drafts.map((draft) =>
      draft.id === id ? { ...draft, name: trimmed, savedAt: new Date().toISOString() } : draft,
    ),
  };
  await saveDrafts(projectId, path, next, storage);
  return next;
}

/** 保存成功后不再清空草稿（S4a2 用户反馈：草稿是修改版本/灵感的记录，
 *  由用户手动管理）；本函数保留给「单文件彻底清除」场景。 */
export async function clearDrafts(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<void> {
  await storage.remove(storageKey(projectId, path));
}

// ---------------------------------------------------------------- 草稿箱（S4a2）

export interface DraftListItem {
  projectId: string;
  path: string;
  draft: FileDraft;
}

function parseStorageKey(key: string): { projectId: string; path: string } | null {
  if (!key.startsWith(DRAFT_PREFIX)) return null;
  const rest = key.slice(DRAFT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  try {
    return {
      projectId: rest.slice(0, dot),
      path: decodeURIComponent(rest.slice(dot + 1)),
    };
  } catch {
    return null;
  }
}

/** 跨文件列出全部草稿（按保存时间新→旧）；损坏的条目跳过。 */
export async function listAllDrafts(
  storage: KVStorage = diskStorage,
): Promise<DraftListItem[]> {
  try {
    const keys = await storage.keys(DRAFT_PREFIX);
    const items: DraftListItem[] = [];
    for (const key of keys) {
      const parsed = parseStorageKey(key);
      if (!parsed) continue;
      const stored = await loadDrafts(parsed.projectId, parsed.path, storage);
      for (const draft of stored.drafts) {
        items.push({ projectId: parsed.projectId, path: parsed.path, draft });
      }
    }
    return items.sort((a, b) => b.draft.savedAt.localeCompare(a.draft.savedAt));
  } catch {
    return [];
  }
}

/** 清空全部草稿（草稿箱「清空」入口，必须由用户确认后调用）；返回清理的文件数。 */
export async function clearAllDrafts(storage: KVStorage = diskStorage): Promise<number> {
  try {
    const keys = await storage.keys(DRAFT_PREFIX);
    for (const key of keys) {
      await storage.remove(key);
    }
    return keys.length;
  } catch {
    return 0;
  }
}
