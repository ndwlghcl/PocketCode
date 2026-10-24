/**
 * 本地仓储层占位（S2/S3 实现 SQLite 适配器 + 应用私有文件目录，架构文档 §0）。
 *
 * 接口先于实现冻结，避免 UI 与缓存实现耦合：
 * - 目录元数据缓存（离线保留文件夹/文件名）
 * - 已打开文件正文缓存（按需缓存策略）
 * - 草稿（独立于缓存；任何缓存清理不得删除草稿）
 */

export interface CachedManifestRecord {
  projectId: string;
  revision: number;
  generatedAt: string;
  /** 序列化后的完整 manifest JSON。 */
  manifestJson: string;
}

export interface CachedFileRecord {
  projectId: string;
  path: string;
  version: string;
  content: string;
  encoding: string;
  newline: string;
  cachedAt: string;
}

export interface LocalRepository {
  getManifest(projectId: string): Promise<CachedManifestRecord | null>;
  putManifest(record: CachedManifestRecord): Promise<void>;
  getFile(projectId: string, path: string): Promise<CachedFileRecord | null>;
  putFile(record: CachedFileRecord): Promise<void>;
  clearFileCache(projectId: string): Promise<void>;
}
