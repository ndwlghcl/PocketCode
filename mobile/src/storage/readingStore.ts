import type { ProjectSummary } from '../api/types';
import { diskStorage, type KVStorage } from '../native';
import { localTransaction } from './localTransactions';

const RECENTS = 'pc.reading.recents';
const MARKS = 'pc.reading.marks.';
export interface RecentFile { project: ProjectSummary; path: string; openedAt: string }
export interface ReadingMark {
  id: string; kind: 'bookmark' | 'note'; line: number; endLine: number;
  quote: string; note: string; version: string; savedAt: string;
}
export async function loadRecents(storage: KVStorage = diskStorage): Promise<RecentFile[]> {
  try {
    const value: unknown = JSON.parse(await storage.get(RECENTS) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is RecentFile => typeof v?.project?.id === 'string' && typeof v.project.name === 'string' && typeof v.path === 'string' && typeof v.openedAt === 'string').slice(0, 20) : [];
  } catch { return []; }
}
export async function rememberFile(project: ProjectSummary, path: string, storage: KVStorage = diskStorage): Promise<void> {
  await localTransaction(storage, async () => {
    const previous = await loadRecents(storage);
    await storage.set(RECENTS, JSON.stringify([{ project, path, openedAt: new Date().toISOString() }, ...previous.filter((v) => v.project.id !== project.id || v.path !== path)].slice(0, 20)));
  });
}
function key(projectId: string, path: string) { return `${MARKS}${projectId}.${encodeURIComponent(path)}`; }
function validMark(v: unknown): v is ReadingMark {
  const m = v as ReadingMark | null;
  return !!m && typeof m.id === 'string' && ['bookmark', 'note'].includes(m.kind) && Number.isInteger(m.line) && m.line > 0 && Number.isInteger(m.endLine) && m.endLine >= m.line && typeof m.quote === 'string' && typeof m.note === 'string' && typeof m.version === 'string' && typeof m.savedAt === 'string';
}
export async function loadMarks(projectId: string, path: string, storage: KVStorage = diskStorage): Promise<ReadingMark[]> {
  const raw = await storage.get(key(projectId, path));
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every(validMark) && new Set(value.map((v) => v.id)).size === value.length) return value;
  } catch { /* 原数据保留 */ }
  throw new Error('书签和旁注无法读取，已阻止覆盖。请重试。');
}
export async function saveMark(projectId: string, path: string, mark: ReadingMark, storage: KVStorage = diskStorage): Promise<ReadingMark[]> {
  return localTransaction(storage, async () => {
    if (!validMark(mark)) throw new Error('旁注数据不完整，未保存');
    const marks = await loadMarks(projectId, path, storage);
    const next = [mark, ...marks.filter((v) => v.id !== mark.id)];
    await storage.set(key(projectId, path), JSON.stringify(next));
    return next;
  });
}
export async function deleteMark(projectId: string, path: string, id: string, storage: KVStorage = diskStorage): Promise<ReadingMark[]> {
  return localTransaction(storage, async () => {
    const next = (await loadMarks(projectId, path, storage)).filter((v) => v.id !== id);
    await storage.set(key(projectId, path), JSON.stringify(next)); return next;
  });
}
/** 内容变动时仅对唯一完整行片段重定位；找不到时保留原行号和原文供用户判断。 */
export function locateMark(mark: ReadingMark, content: string): { line: number; matched: boolean } {
  const lines = content.split('\n');
  const quote = mark.quote.split('\n');
  const hits: number[] = [];
  if (mark.quote) for (let i = 0; i <= lines.length - quote.length; i++) {
    if (quote.every((line, j) => line === lines[i + j])) hits.push(i + 1);
  }
  return hits.length === 1 ? { line: hits[0], matched: true } : { line: Math.max(1, Math.min(mark.line, lines.length)), matched: false };
}

export async function relocateReading(projectId: string, path: string, targetPath: string, storage: KVStorage = diskStorage): Promise<void> {
  await localTransaction(storage, async () => {
    const old = await loadMarks(projectId, path, storage);
    const destination = await loadMarks(projectId, targetPath, storage);
    if (old.length) {
      const ids = new Set(destination.map((m) => m.id));
      const moved = old.map((mark) => ({ ...mark, id: ids.has(mark.id) ? crypto.randomUUID() : mark.id }));
      await storage.set(key(projectId, targetPath), JSON.stringify([...destination, ...moved]));
      await storage.remove(key(projectId, path));
    }
    const recents = await loadRecents(storage);
    const next = recents.map((v) => v.project.id === projectId && v.path === path ? { ...v, path: targetPath } : v);
    const seen = new Set<string>();
    await storage.set(RECENTS, JSON.stringify(next.filter((v) => { const id = JSON.stringify([v.project.id, v.path]); if (seen.has(id)) return false; seen.add(id); return true; })));
    const positionKey = `pc.readpos.${projectId}.`;
    const position = await storage.get(positionKey + encodeURIComponent(path));
    if (position !== null) { await storage.set(positionKey + encodeURIComponent(targetPath), position); await storage.remove(positionKey + encodeURIComponent(path)); }
  });
}
