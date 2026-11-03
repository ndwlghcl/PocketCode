import { diskStorage, type KVStorage } from '../native';
import type { ManifestNode } from '../api/types';
import { loadCachedFile, loadCachedManifest } from './cacheStore';

export interface CacheInventory { files: number; bytes: number; directoryFiles: number; current: number; stale: number; unreadable: number; fetchedAt: string | null; truncated: boolean }
export async function cacheInventory(projectId: string, storage: KVStorage = diskStorage): Promise<CacheInventory> {
  const manifest = await loadCachedManifest(projectId, storage);
  const versions = new Map<string, string>();
  const scan = (nodes: ManifestNode[]) => { for (const node of nodes) if (node.type === 'dir') scan(node.children); else versions.set(node.path, node.version); };
  if (manifest) scan(manifest.root.children);
  const keys = await storage.keys(`pc.cache.file.${projectId}.`);
  const result: CacheInventory = { files: 0, bytes: 0, directoryFiles: versions.size, current: 0, stale: 0, unreadable: 0, fetchedAt: manifest?.fetchedAt ?? null, truncated: manifest?.truncated ?? false };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(keys.length, 4) }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      try {
        const path = decodeURIComponent(key.slice(`pc.cache.file.${projectId}.`.length));
        const cached = await loadCachedFile(projectId, path, storage);
        if (!cached || typeof cached.data?.content !== 'string') { result.unreadable++; continue; }
        result.files++; result.bytes += new TextEncoder().encode(cached.data.content).byteLength;
        if (versions.get(path) === cached.data.version) result.current++; else result.stale++;
      } catch { result.unreadable++; }
    }
  }));
  return result;
}
/** 只操作该项目的缓存键，草稿、旁注、配对和其他项目均保留。调用前须等待缓存任务停止。 */
export async function clearProjectCache(projectId: string, storage: KVStorage = diskStorage): Promise<void> {
  const keys = await storage.keys(`pc.cache.file.${projectId}.`);
  for (const key of keys) await storage.remove(key);
  await storage.remove(`pc.cache.manifest.${projectId}`);
  await storage.remove(`pc.cache.report.${projectId}`);
}
