import { PocketCodeError, type PocketCodeClient } from '../../api/client';
import { loadCachedFile, saveCachedFile } from '../../storage/cacheStore';
import type { BundleFile, ShareSource } from './bundle';

export type ShareFormat = 'text' | 'zip';
export const MAX_SHARE_FILES = 1000;
export const MAX_ZIP_BYTES = 10 * 1024 * 1024;
export interface PreparedBundle {
  files: BundleFile[];
  skipped: { path: string; reason: string }[];
  source: ShareSource;
  fetchedAt: string | null;
  format: ShareFormat;
  bytes: number;
}

export async function prepareBundle(client: Pick<PocketCodeClient, 'readFile'> | null, projectId: string,
  paths: string[], online: boolean, format: ShareFormat, onProgress?: (done: number) => void, signal?: AbortSignal,
): Promise<PreparedBundle> {
  if (paths.length > MAX_SHARE_FILES) throw new Error(`一次最多分享 ${MAX_SHARE_FILES} 个文件，请缩小选择范围`);
  const result: PreparedBundle = { files: [], skipped: [], source: online ? 'pc' : 'cache', fetchedAt: null, format, bytes: 0 };
  let chars = 0, useNetwork = online;
  const encoder = new TextEncoder();
  const checkAbort = () => { if (signal?.aborted) throw new Error('已取消准备'); };
  for (const path of paths) {
    checkAbort();
    let file: BundleFile | null = null;
    let failure = '没有本地缓存';
    if (client && useNetwork) {
      try {
        const data = await client.readFile(projectId, path);
        checkAbort();
        file = { path, content: data.content, source: 'pc', version: data.version, fetchedAt: data.mtime };
        void saveCachedFile(projectId, data);
      } catch (cause) {
        if (cause instanceof PocketCodeError && (cause.status === 401 || cause.code === 'PROJECT_NOT_FOUND' || cause.code === 'PATH_FORBIDDEN' || cause.details?.kind === 'tls')) throw cause;
        if (cause instanceof PocketCodeError && (cause.code === 'UNSUPPORTED_FORMAT' || cause.code === 'FILE_TOO_LARGE' || cause.code === 'FILE_NOT_FOUND' || cause.code === 'NOT_FOUND')) {
          result.skipped.push({ path, reason: cause.message }); onProgress?.(result.files.length + result.skipped.length); continue;
        }
        failure = cause instanceof Error ? cause.message : '电脑读取失败';
        if (cause instanceof PocketCodeError && cause.code === 'OFFLINE') useNetwork = false;
      }
    }
    checkAbort();
    if (!file) {
      const cached = await loadCachedFile(projectId, path);
      checkAbort();
      if (cached) file = { path, content: cached.data.content, source: 'cache', version: cached.data.version, fetchedAt: cached.fetchedAt };
    }
    if (!file) result.skipped.push({ path, reason: failure });
    else {
      const bytes = encoder.encode(file.content).byteLength;
      if ((format === 'text' && chars + file.content.length > 200_000) || (format === 'zip' && result.bytes + bytes > MAX_ZIP_BYTES)) {
        result.skipped.push({ path, reason: format === 'zip' ? '超过 ZIP 正文总计 10 MiB 上限' : '超过文本包 20 万字符上限' });
      } else {
        result.files.push(file); chars += file.content.length; result.bytes += bytes;
        result.fetchedAt = file.fetchedAt ?? null;
        if (file.source === 'cache') result.source = 'cache';
      }
    }
    onProgress?.(result.files.length + result.skipped.length);
  }
  if (!result.files.length) throw new Error('所选文件没有可分享的内容，请检查网络、缓存或未缓存文件的格式。');
  return result;
}
