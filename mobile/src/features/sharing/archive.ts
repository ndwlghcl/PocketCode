import { zip, strToU8, type Zippable } from 'fflate';
import type { PreparedBundle } from './prepareBundle';
import { MAX_SHARE_FILES, MAX_ZIP_BYTES } from './prepareBundle';

export function archiveName(projectName: string): string {
  const safe = projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 70) || 'project';
  return `PocketCode-${safe}.zip`;
}

export async function buildShareArchive(projectName: string, bundle: PreparedBundle): Promise<Uint8Array> {
  if (!bundle.files.length || bundle.files.length > MAX_SHARE_FILES) throw new Error('ZIP 文件数量无效');
  const entries: Zippable = Object.create(null);
  const seen = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    const path = file.path;
    if (/[:\\\x00-\x1f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`无法打包不安全的相对路径：${path}`);
    const canonical = path.toLowerCase();
    if (seen.has(canonical)) throw new Error(`ZIP 路径重复：${path}`);
    seen.add(canonical);
    const data = strToU8(file.content);
    total += data.byteLength;
    if (total > MAX_ZIP_BYTES) throw new Error('ZIP 正文超过 10 MiB 上限');
    entries[path] = data;
  }
  for (const path of seen) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (seen.has(parts.join('/'))) throw new Error('ZIP 中存在文件与目录重名'); parts.pop(); }
  }
  let note = 'PocketCode-分享说明.json', suffix = 1;
  while (seen.has(note.toLowerCase()) || [...seen].some((path) => path.startsWith(note.toLowerCase() + '/'))) note = `PocketCode-分享说明-${suffix++}.json`;
  entries[note] = strToU8(JSON.stringify({
    project: projectName, createdAt: new Date().toISOString(), encoding: 'UTF-8',
    description: '所选代码的文本导出，保留相对目录结构；不是原始二进制备份。缓存内容可能过期。',
    files: bundle.files.map(({ path, source, version, fetchedAt }) => ({ path, source: source ?? bundle.source, version, fetchedAt })),
    skipped: bundle.skipped,
  }, null, 2));
  return new Promise((resolve, reject) => zip(entries, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
}
