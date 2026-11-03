/**
 * 草稿箱（S3b）：每个文件的本地未保存修改。
 *
 * 规则（PRD §6.2）：
 * - 每个文件支持多份命名草稿（如「异常处理实验 A」「随便改着玩」）；
 * - 草稿独立于文件缓存，保存到电脑成功后仍保留，由用户手动删除；
 * - 草稿记录 baseVersion（编辑所基于的电脑版本），保存冲突检测依赖它；
 * - 存储走原生文件 KV（可靠落盘，不使用可能被系统清理的 WebView
 *   localStorage）；键前缀 pc.draft.* 与缓存 pc.cache.* 分离，互不影响。
 */

import { diskStorage, type KVStorage } from '../native';
import type { TextEncoding, NewlineStyle } from '../api/types';

const DRAFT_PREFIX = 'pc.draft.';

export class DraftStorageError extends Error {}

// 所有页面共用同一条存储事务队列，清空和单文件读改写也不会互相穿插。
const queues = new WeakMap<KVStorage, Promise<void>>();
function transaction<T>(storage: KVStorage, operation: () => Promise<T>): Promise<T> {
  const run = (queues.get(storage) ?? Promise.resolve()).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(storage, settled);
  void settled.then(() => { if (queues.get(storage) === settled) queues.delete(storage); });
  return run;
}

export interface FileDraft {
  id: string;
  name: string;
  path: string;
  projectId: string;
  content: string;
  /** 编辑所基于的电脑文件版本；保存时作为 base_version。 */
  baseVersion: string;
  savedAt: string;
  /** 旧草稿可缺省；只从真实来源文件补齐，不伪造其编码或版本。 */
  encoding?: TextEncoding;
  newline?: NewlineStyle;
  projectName?: string;
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
    typeof draft.savedAt === 'string' &&
    (draft.encoding === undefined || ['utf-8', 'utf-8-bom', 'utf-16-le', 'utf-16-be'].includes(draft.encoding)) &&
    (draft.newline === undefined || ['LF', 'CRLF', 'CR'].includes(draft.newline)) &&
    (draft.projectName === undefined || typeof draft.projectName === 'string')
  );
}

export async function loadDrafts(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  return transaction(storage, () => readDrafts(projectId, path, storage));
}

async function readDrafts(projectId: string, path: string, storage: KVStorage): Promise<StoredDrafts> {
  try {
    const raw = await storage.get(storageKey(projectId, path));
    if (raw === null) return { activeId: null, drafts: [] };
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredDrafts>;
      if (parsed && Array.isArray(parsed.drafts) && parsed.drafts.every(isValidDraft)) {
        const drafts = parsed.drafts;
        if (new Set(drafts.map((draft) => draft.id)).size !== drafts.length) throw new Error('duplicate ids');
        const activeId =
          typeof parsed.activeId === 'string' &&
          drafts.some((draft) => draft.id === parsed.activeId)
            ? parsed.activeId
            : (drafts[0]?.id ?? null);
        return { activeId, drafts };
      }
    }
  } catch {
    throw new DraftStorageError(`无法读取草稿「${path}」，原数据未改动；请重试或备份后处理。`);
  }
  throw new DraftStorageError(`草稿「${path}」格式损坏，已阻止覆盖写入，原数据保留。`);
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
  return transaction(storage, async () => {
    const stored = await readDrafts(projectId, path, storage);
    const existing = stored.drafts.find((item) => item.id === draft.id);
    const next: StoredDrafts = {
      activeId: draft.id,
      drafts: [{ ...existing, ...draft, projectId, path }, ...stored.drafts.filter((existing) => existing.id !== draft.id)],
    };
    if (!next.drafts.every(isValidDraft)) throw new DraftStorageError('草稿数据不完整，未写入');
    await saveDrafts(projectId, path, next, storage);
    return next;
  });
}

export async function setActiveDraft(
  projectId: string,
  path: string,
  id: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  return transaction(storage, async () => {
    const stored = await readDrafts(projectId, path, storage);
    if (!stored.drafts.some((draft) => draft.id === id)) throw new DraftStorageError('草稿已不存在，请刷新草稿箱');
    const next: StoredDrafts = { ...stored, activeId: id };
    await saveDrafts(projectId, path, next, storage);
    return next;
  });
}

/** 删除一份草稿；若删的是活动草稿则顺延到最近一份。 */
export async function removeDraft(
  projectId: string,
  path: string,
  id: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts> {
  return transaction(storage, async () => {
    const stored = await readDrafts(projectId, path, storage);
    const drafts = stored.drafts.filter((draft) => draft.id !== id);
    const next: StoredDrafts = {
      activeId: stored.activeId === id ? (drafts[0]?.id ?? null) : stored.activeId,
      drafts,
    };
    await saveDrafts(projectId, path, next, storage);
    return next;
  });
}

/** 重命名一份草稿（S4a：内容与活动态都不变，只改名字）。 */
export async function renameDraft(
  projectId: string,
  path: string,
  id: string,
  name: string,
  storage: KVStorage = diskStorage,
): Promise<StoredDrafts | null> {
  return transaction(storage, async () => {
    const stored = await readDrafts(projectId, path, storage);
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
  });
}

/** 保存成功后不再清空草稿（S4a2 用户反馈：草稿是修改版本/灵感的记录，
 *  由用户手动管理）；本函数保留给「单文件彻底清除」场景。 */
export async function clearDrafts(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<void> {
  await transaction(storage, () => storage.remove(storageKey(projectId, path)));
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

/** 跨文件列出全部草稿；读取失败必须由界面明确报告。 */
export async function listAllDrafts(
  storage: KVStorage = diskStorage,
  onReadError?: (message: string) => void,
): Promise<DraftListItem[]> {
  return transaction(storage, async () => {
    try {
      const keys = await storage.keys(DRAFT_PREFIX);
      const items: DraftListItem[] = [];
      for (const key of keys) {
        const parsed = parseStorageKey(key);
        if (!parsed) continue;
        try {
          const stored = await readDrafts(parsed.projectId, parsed.path, storage);
          for (const draft of stored.drafts) {
            items.push({ projectId: parsed.projectId, path: parsed.path, draft });
          }
        } catch (error) {
          if (!onReadError) throw error;
          onReadError(error instanceof Error ? error.message : '部分草稿读取失败，原数据保留');
        }
      }
      return items.sort((a, b) => b.draft.savedAt.localeCompare(a.draft.savedAt));
    } catch (error) {
      if (error instanceof DraftStorageError) throw error;
      throw new DraftStorageError('无法读取草稿箱，原数据未改动，请重试');
    }
  });
}

/** 清空全部草稿（草稿箱「清空」入口，必须由用户确认后调用）；返回清理的文件数。 */
export async function clearAllDrafts(storage: KVStorage = diskStorage): Promise<number> {
  return transaction(storage, async () => {
    const keys = await storage.keys(DRAFT_PREFIX);
    for (const key of keys) {
      await storage.remove(key);
    }
    return keys.length;
  });
}

/** 电脑移动成功后，先完整合并到新位置再移除旧键；任何读取失败均不覆盖。 */
export async function relocateFileDrafts(projectId: string, path: string, targetPath: string, storage: KVStorage = diskStorage): Promise<void> {
  return transaction(storage, async () => {
    const old = await readDrafts(projectId, path, storage);
    if (!old.drafts.length) return;
    const destination = await readDrafts(projectId, targetPath, storage);
    const ids = new Set(destination.drafts.map((d) => d.id));
    let activeId = destination.activeId;
    const moved = old.drafts.map((draft) => {
      const id = ids.has(draft.id) ? newDraftId() : draft.id; ids.add(id);
      if (!activeId && draft.id === old.activeId) activeId = id;
      return { ...draft, id, path: targetPath };
    });
    await saveDrafts(projectId, targetPath, { activeId: activeId ?? moved[0].id, drafts: [...destination.drafts, ...moved] }, storage);
    await storage.remove(storageKey(projectId, path));
  });
}

export interface DraftBackup { format: 'pocketcode-drafts'; version: 1; createdAt: string; drafts: FileDraft[] }
const BACKUP_LIMIT = 16 * 1024 * 1024;
export function validateDraftBackup(value: unknown): DraftBackup {
  const backup = value as Partial<DraftBackup> | null;
  if (!backup || backup.format !== 'pocketcode-drafts' || backup.version !== 1 || typeof backup.createdAt !== 'string' || !Array.isArray(backup.drafts) || backup.drafts.length > 10000) throw new DraftStorageError('不是支持的 PocketCode 草稿备份（版本 1）');
  const drafts: FileDraft[] = [];
  for (const value of backup.drafts) {
    if (!isValidDraft(value) || !/^[\w-]{1,128}$/.test(value.projectId) || value.path.length > 512 || /[\\:\x00-\x1f\x7f]/.test(value.path) || value.path.split('/').some((part) => !part || part === '.' || part === '..')) throw new DraftStorageError('备份中有无效草稿，未恢复任何内容');
    // 只接收约定字段，备份中的额外对象/属性不会进入存储。
    drafts.push({ id: value.id, name: value.name, path: value.path, projectId: value.projectId, content: value.content, baseVersion: value.baseVersion, savedAt: value.savedAt, ...(value.encoding ? { encoding: value.encoding } : {}), ...(value.newline ? { newline: value.newline } : {}), ...(value.projectName !== undefined ? { projectName: value.projectName } : {}) });
  }
  const result: DraftBackup = { format: 'pocketcode-drafts', version: 1, createdAt: backup.createdAt, drafts };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > BACKUP_LIMIT) throw new DraftStorageError('草稿备份超过 16 MiB 上限');
  return result;
}

/** 导出必须完整读取；不能把读取失败伪装成一份完整备份。 */
export async function exportDraftBackup(storage: KVStorage = diskStorage): Promise<DraftBackup> {
  return transaction(storage, async () => {
    const drafts: FileDraft[] = [];
    for (const key of await storage.keys(DRAFT_PREFIX)) {
      const location = parseStorageKey(key);
      if (!location) throw new DraftStorageError('草稿索引无法读取，已停止整批备份；原数据保留');
      const stored = await readDrafts(location.projectId, location.path, storage);
      for (const draft of stored.drafts) drafts.push({ ...draft, ...location });
    }
    return validateDraftBackup({ format: 'pocketcode-drafts', version: 1, createdAt: new Date().toISOString(), drafts });
  });
}

/** 恢复只追加；先完整验证并读取所有目标文件，同名/同 ID 的旧版本不覆盖。 */
export async function restoreDraftBackup(value: unknown, storage: KVStorage = diskStorage): Promise<{ restored: number; skipped: number }> {
  const backup = validateDraftBackup(value);
  return transaction(storage, async () => {
    const groups = new Map<string, { projectId: string; path: string; stored: StoredDrafts; added: number }>();
    let skipped = 0;
    for (const draft of backup.drafts) {
      const key = storageKey(draft.projectId, draft.path);
      if (!groups.has(key)) groups.set(key, { projectId: draft.projectId, path: draft.path, stored: await readDrafts(draft.projectId, draft.path, storage), added: 0 });
      const group = groups.get(key)!;
      if (group.stored.drafts.some((v) => v.name === draft.name && v.content === draft.content && v.baseVersion === draft.baseVersion && v.savedAt === draft.savedAt && v.encoding === draft.encoding && v.newline === draft.newline)) { skipped++; continue; }
      const restored = { ...draft, id: newDraftId() };
      group.stored = { activeId: group.stored.activeId ?? restored.id, drafts: [...group.stored.drafts, restored] };
      group.added++;
    }
    let restored = 0;
    for (const group of groups.values()) {
      if (!group.added) continue;
      try { await saveDrafts(group.projectId, group.path, group.stored, storage); restored += group.added; }
      catch { throw new DraftStorageError(`恢复中断：已恢复 ${restored} 份，未完成的可重试；原有草稿均保留。`); }
    }
    return { restored, skipped };
  });
}
