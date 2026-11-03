import type { PocketCodeClient } from '../../api/client';
import { diskStorage, type KVStorage } from '../../native';
import { cacheProject, type ProjectCacheProgress } from './cacheProject';
import { clearProjectCache } from '../../storage/cacheInventory';

export interface CacheJob { busy: boolean; progress: ProjectCacheProgress | null; error: string | null; finishedAt: string | null; stopping?: boolean; clearing?: boolean }
const EMPTY: CacheJob = { busy: false, progress: null, error: null, finishedAt: null };
/** 应用内任务独立于页面。系统终止进程后不伪装成仍在运行；已缓存文件照常保留。 */
export class CacheJobs {
  private jobs = new Map<string, CacheJob>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private listeners = new Set<() => void>();
  private maintenance = new Set<string>();
  constructor(private storage: KVStorage = diskStorage) {}
  get(projectId: string): CacheJob { return this.jobs.get(projectId) ?? EMPTY; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(projectId: string, value: CacheJob) { this.jobs.set(projectId, this.maintenance.has(projectId) ? { ...value, clearing: true } : value); for (const listener of this.listeners) listener(); }
  async load(projectId: string): Promise<void> {
    if (this.jobs.has(projectId)) return;
    try {
      const value = JSON.parse(await this.storage.get(`pc.cache.report.${projectId}`) ?? 'null');
      if (value && typeof value.finishedAt === 'string' && value.progress && Array.isArray(value.progress.issues) && !this.jobs.has(projectId)) this.emit(projectId, { ...value, busy: false });
    } catch { /* 缓存报告损坏不影响正文和草稿 */ }
  }
  start(projectId: string, client: Pick<PocketCodeClient, 'getManifest' | 'readFile'>, paths?: ReadonlySet<string>): Promise<void> {
    if (this.maintenance.has(projectId)) return Promise.resolve();
    const previous = this.active.get(projectId);
    if (previous) return previous.promise;
    const controller = new AbortController();
    this.emit(projectId, { ...EMPTY, busy: true });
    const promise = Promise.resolve().then(async () => {
      try {
        const progress = await cacheProject(client, projectId, { storage: this.storage, signal: controller.signal, paths, onProgress: (value) => this.emit(projectId, { ...this.get(projectId), progress: value }) });
        this.emit(projectId, { busy: false, progress, error: null, finishedAt: new Date().toISOString() });
      } catch (cause) { this.emit(projectId, { ...this.get(projectId), busy: false, error: cause instanceof Error ? cause.message : '缓存失败', finishedAt: new Date().toISOString() }); }
      try { await this.storage.set(`pc.cache.report.${projectId}`, JSON.stringify(this.get(projectId))); }
      catch { this.emit(projectId, { ...this.get(projectId), error: '缓存结果未能保存，请检查存储空间；已缓存正文仍会保留。' }); }
      finally { this.active.delete(projectId); }
    });
    this.active.set(projectId, { controller, promise });
    return promise;
  }
  async stop(projectId: string) { const job = this.active.get(projectId); if (job) { this.emit(projectId, { ...this.get(projectId), stopping: true }); job.controller.abort(); await job.promise; } }
  async stopAll() { await Promise.all([...this.active.keys()].map((id) => this.stop(id))); }
  async clear(projectId: string) {
    if (this.maintenance.has(projectId)) return;
    this.maintenance.add(projectId); this.emit(projectId, this.get(projectId));
    try { await this.stop(projectId); await clearProjectCache(projectId, this.storage); }
    finally { this.maintenance.delete(projectId); this.forget(projectId); }
  }
  forget(projectId: string) { this.jobs.delete(projectId); for (const listener of this.listeners) listener(); }
}
export const cacheJobs = new CacheJobs();
