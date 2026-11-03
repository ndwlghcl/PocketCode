import { unzipSync, zip } from 'fflate';
import { exportDraftBackup, validateDraftBackup, type DraftBackup } from '../../storage/draftStore';
import type { KVStorage } from '../../native';

const ENTRY = 'PocketCode-草稿备份.json';
const LIMIT = 16 * 1024 * 1024;
export async function buildDraftBackup(storage?: KVStorage): Promise<{ name: string; bytes: Uint8Array; count: number }> {
  const backup = await exportDraftBackup(storage);
  const json = new TextEncoder().encode(JSON.stringify(backup, null, 2));
  if (json.length > LIMIT) throw new Error('草稿备份超过 16 MiB 上限');
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip({ [ENTRY]: json }, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
  return { name: `PocketCode-草稿备份-${new Date().toISOString().slice(0, 10)}.zip`, bytes, count: backup.drafts.length };
}
export function parseDraftBackup(bytes: Uint8Array): DraftBackup {
  if (bytes.length > LIMIT) throw new Error('备份文件超过 16 MiB 上限');
  let json = bytes;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let entries = 0;
    const files = unzipSync(bytes, { filter: (file) => {
      entries++;
      if (entries > 1 || file.name !== ENTRY || file.originalSize > LIMIT || file.originalSize < 0) throw new Error('压缩包不是有效的 PocketCode 草稿备份');
      return true;
    } });
    if (entries !== 1 || !files[ENTRY]) throw new Error('压缩包内缺少草稿备份');
    json = files[ENTRY];
  }
  if (json.length > LIMIT) throw new Error('解压后的草稿备份超过 16 MiB 上限');
  try { return validateDraftBackup(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))); }
  catch (cause) { throw new Error(cause instanceof Error ? cause.message : '备份无法读取，原有草稿保留'); }
}
