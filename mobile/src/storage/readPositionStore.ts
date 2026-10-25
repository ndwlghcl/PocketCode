/**
 * 阅读位置持久化（S4a）：每个文件的阅读位置跨 App 重启保留（PRD §4.2）。
 *
 * 之前挂在 window scroll 上的记忆在真机 WebView 上不生效（挂起问题，
 * 见 HANDOFF §5）；S4a 换 CodeMirror 后滚动容器是编辑器内部的 scroller，
 * 位置直接从 EditorView 读，落到原生文件 KV，重启后仍能恢复。
 * 写入做 500ms 节流：滚动事件很密，不能每次都跨桥写盘。
 */

import { diskStorage, type KVStorage } from '../native';

const PREFIX = 'pc.readpos.';

export interface ReadPosition {
  /** CodeMirror scroller 的 scrollTop（像素）。 */
  scrollTop: number;
  savedAt: string;
}

function storageKey(projectId: string, path: string): string {
  return `${PREFIX}${projectId}.${encodeURIComponent(path)}`;
}

export async function loadReadPosition(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): Promise<ReadPosition | null> {
  try {
    const raw = await storage.get(storageKey(projectId, path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReadPosition>;
    if (typeof parsed.scrollTop !== 'number' || !Number.isFinite(parsed.scrollTop)) {
      return null;
    }
    return { scrollTop: parsed.scrollTop, savedAt: String(parsed.savedAt ?? '') };
  } catch {
    return null;
  }
}

export async function saveReadPosition(
  projectId: string,
  path: string,
  scrollTop: number,
  storage: KVStorage = diskStorage,
): Promise<void> {
  try {
    await storage.set(
      storageKey(projectId, path),
      JSON.stringify({ scrollTop, savedAt: new Date().toISOString() }),
    );
  } catch {
    // 存不进去就放弃记忆，不影响阅读
  }
}

/** 滚动节流器：500ms 合并写入；flush 立即落盘（卸载/切后台时调用）。 */
export function createPositionSaver(
  projectId: string,
  path: string,
  storage: KVStorage = diskStorage,
): {
  push: (scrollTop: number) => void;
  flush: () => Promise<void>;
} {
  const DEBOUNCE_MS = 500;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const write = async (value: number) => {
    await saveReadPosition(projectId, path, value, storage);
  };

  return {
    push(scrollTop: number) {
      pending = scrollTop;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const value = pending;
        pending = null;
        if (value !== null) void write(value);
      }, DEBOUNCE_MS);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const value = pending;
      pending = null;
      if (value !== null) await write(value);
    },
  };
}
