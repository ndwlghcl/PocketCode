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

/** 保存成功后清空该文件全部草稿（内容已与电脑一致）。 */
export async function clearDrafts(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<void> {
  await storage.remove(storageKey(projectId, path));
}
