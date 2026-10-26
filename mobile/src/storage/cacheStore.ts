/**
 * 只读缓存（S2/S3）：项目列表、目录快照、文件内容缓存到原生磁盘 KV。
 *
 * 离线时展示上次缓存并明确标注"来自缓存"；缓存键 pc.cache.* 与草稿
 * pc.draft.* 分离，清理缓存不影响草稿。
 */

import type { FileContentResponse, ManifestDir, ProjectSummary } from '../api/types';
import { diskStorage, type KVStorage } from '../native';

const PROJECTS_KEY = 'pc.cache.projects';
const MANIFEST_PREFIX = 'pc.cache.manifest.';
const FILE_PREFIX = 'pc.cache.file.';

/** 单文件内容缓存上限（字符数）；超过则不入缓存（避免撑爆本地存储）。 */
const MAX_CACHED_FILE_CHARS = 1_000_000;

export interface CachedProjects {
  fetchedAt: string;
  projects: ProjectSummary[];
}

export interface CachedManifest {
  fetchedAt: string;
  revision: number;
  root: ManifestDir;
}

export interface CachedFile {
  fetchedAt: string;
  data: FileContentResponse;
}

async function readJson<T>(
  key: string,
  validate: (value: unknown) => boolean,
  storage: KVStorage = diskStorage,
): Promise<T | null> {
  try {
    const raw = await storage.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(
  key: string,
  value: unknown,
  storage: KVStorage = diskStorage,
): Promise<boolean> {
  try {
    await storage.set(key, JSON.stringify(value));
    return true;
  } catch {
    // 空间不足等场景：缓存失败不阻塞功能
    return false;
  }
}

export async function loadCachedProjects(
  storage: KVStorage = diskStorage,
): Promise<CachedProjects | null> {
  return readJson<CachedProjects>(
    PROJECTS_KEY,
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as CachedProjects).projects),
    storage,
  );
}

export async function saveCachedProjects(
  projects: ProjectSummary[],
  storage: KVStorage = diskStorage,
): Promise<void> {
  await writeJson(
    PROJECTS_KEY,
    { fetchedAt: new Date().toISOString(), projects },
    storage,
  );
}

export async function loadCachedManifest(
  projectId: string,
  storage: KVStorage = diskStorage,
): Promise<CachedManifest | null> {
  return readJson<CachedManifest>(
    `${MANIFEST_PREFIX}${projectId}`,
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as CachedManifest).revision === 'number' &&
      typeof (value as CachedManifest).root === 'object',
    storage,
  );
}

export async function saveCachedManifest(
  projectId: string,
  manifest: { revision: number; root: ManifestDir },
  storage: KVStorage = diskStorage,
): Promise<boolean> {
  return writeJson(
    `${MANIFEST_PREFIX}${projectId}`,
    {
      fetchedAt: new Date().toISOString(),
      revision: manifest.revision,
      root: manifest.root,
    },
    storage,
  );
}

function fileKey(projectId: string, path: string): string {
  return `${FILE_PREFIX}${projectId}.${encodeURIComponent(path)}`;
}

export async function loadCachedFile(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<CachedFile | null> {
  return readJson<CachedFile>(
    fileKey(projectId, path),
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as CachedFile).fetchedAt === 'string' &&
      typeof (value as CachedFile).data === 'object',
    storage,
  );
}

export async function saveCachedFile(
  projectId: string,
  data: FileContentResponse,
  storage: KVStorage = diskStorage,
): Promise<boolean> {
  if (data.content.length > MAX_CACHED_FILE_CHARS) return false;
  return writeJson(
    fileKey(projectId, data.path),
    { fetchedAt: new Date().toISOString(), data },
    storage,
  );
}
