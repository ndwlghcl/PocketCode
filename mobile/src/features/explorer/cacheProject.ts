import { PocketCodeError, type PocketCodeClient } from '../../api/client';
import type { ManifestFile, ManifestNode } from '../../api/types';
import { diskStorage, type KVStorage } from '../../native';
import { loadCachedFile, saveCachedFile, saveCachedManifest } from '../../storage/cacheStore';

const MAX_FILE_BYTES = 1_000_000;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const WORKERS = 3;
const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.gradle',
  'build', 'dist', 'out', 'target', '.next', '.nuxt', 'coverage',
]);
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

export interface ProjectCacheProgress {
  total: number;
  completed: number;
  saved: number;
  reused: number;
  skipped: number;
  failed: number;
  bytes: number;
  truncated: boolean;
  stopped: string | null;
  issues: { path: string; reason: string }[];
  failedPaths?: string[];
}

/** 使用现有只读接口和缓存键；不会访问或修改草稿。取消时保留已落盘的部分。 */
export async function cacheProject(
  client: Pick<PocketCodeClient, 'getManifest' | 'readFile'>,
  projectId: string,
  options: { signal?: AbortSignal; onProgress?: (value: ProjectCacheProgress) => void; storage?: KVStorage; paths?: ReadonlySet<string> } = {},
): Promise<ProjectCacheProgress> {
  const { signal, onProgress, storage = diskStorage } = options;
  const progress: ProjectCacheProgress = {
    total: 0, completed: 0, saved: 0, reused: 0, skipped: 0, failed: 0,
    bytes: 0, truncated: false, stopped: null, issues: [], failedPaths: [],
  };
  // 界面只展示前 50 个原因，避免大项目反复复制全部问题列表。
  const snapshot = () => ({ ...progress, issues: progress.issues.slice(0, 50), failedPaths: [...progress.failedPaths!] });
  let lastEmit = 0;
  const emit = () => {
    const now = Date.now();
    if (progress.completed <= 3 || progress.completed === progress.total || progress.stopped || now - lastEmit >= 100) {
      lastEmit = now;
      onProgress?.(snapshot());
    }
  };
  const stopped = () => {
    if (signal?.aborted && !progress.stopped) progress.stopped = '已停止，已完成的缓存会保留';
    return progress.stopped !== null;
  };
  if (stopped()) return snapshot();
  const manifest = await client.getManifest(projectId);
  if (stopped()) return snapshot();
  if (!await saveCachedManifest(projectId, manifest, storage)) throw new Error('目录缓存写入失败，请检查手机存储空间');
  const files: { file: ManifestFile; reason?: string }[] = [];
  const stack: { node: ManifestNode; excluded: boolean }[] = manifest.root.children.map((node) => ({ node, excluded: false })).reverse();
  while (stack.length) {
    const { node, excluded } = stack.pop()!;
    if (node.type === 'dir') {
      const skip = excluded || EXCLUDED_DIRS.has(node.name.toLowerCase());
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], excluded: skip });
    } else {
      if (options.paths && !options.paths.has(node.path)) continue;
      files.push({ file: node, reason: excluded ? '依赖或构建目录' : SENSITIVE_FILE.test(node.name) ? '密钥或敏感配置' : node.size > MAX_FILE_BYTES ? '超过单文件 1 MB 上限' : undefined });
    }
  }
  progress.total = files.length;
  progress.truncated = manifest.truncated;
  emit();
  let next = 0;
  const encoder = new TextEncoder();
  const worker = async () => {
    while (!stopped() && next < files.length) {
      const { file, reason } = files[next++];
      try {
        if (reason) {
          progress.skipped++;
          progress.issues.push({ path: file.path, reason });
          continue;
        }
        const cached = await loadCachedFile(projectId, file.path, storage);
        if (stopped()) return;
        const reuse = cached?.data.version === file.version && typeof cached.data.content === 'string';
        const data = reuse ? cached.data : await client.readFile(projectId, file.path);
        if (stopped()) return;
        const bytes = encoder.encode(data.content).byteLength;
        if (bytes > MAX_FILE_BYTES || data.content.length > MAX_FILE_BYTES) {
          progress.skipped++;
          progress.issues.push({ path: file.path, reason: '超过单文件 1 MB 上限' });
          continue;
        }
        if (progress.bytes + bytes > MAX_PROJECT_BYTES) {
          progress.skipped++;
          progress.issues.push({ path: file.path, reason: '超过本次项目缓存 50 MiB 上限' });
          continue;
        }
        // 在 await 之前占用额度，三个 worker 的总量也不会越界。
        progress.bytes += bytes;
        if (reuse) progress.reused++;
        else if (await saveCachedFile(projectId, data, storage)) progress.saved++;
        else {
          progress.bytes -= bytes;
          throw new Error('文件缓存写入失败，请检查手机存储空间');
        }
      } catch (error) {
        if (stopped()) return;
        const code = error instanceof PocketCodeError ? error.code : null;
        const reason = error instanceof Error ? error.message : '缓存失败';
        if (code === 'UNSUPPORTED_FORMAT' || code === 'FILE_TOO_LARGE') progress.skipped++;
        else { progress.failed++; progress.failedPaths!.push(file.path); }
        progress.issues.push({ path: file.path, reason });
        if (code === 'OFFLINE' || (error instanceof PocketCodeError && error.status === 401) || code === 'PROJECT_NOT_FOUND' || !(error instanceof PocketCodeError)) {
          progress.stopped = reason;
        }
      } finally {
        // 取消/致命失败时，其他尚未落盘的请求不算作已缓存。
        progress.completed = progress.saved + progress.reused + progress.skipped + progress.failed;
        emit();
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  stopped();
  return snapshot();
}
