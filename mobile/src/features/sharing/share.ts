/**
 * 系统分享封装（S4f「给哥哥看」）：Android 原生分享面板；浏览器开发模式
 * 退化为 navigator.share，再退化为复制到剪贴板。绝不静默丢内容——
 * 失败时返回 false 让界面给出提示。
 */

import { Capacitor } from '@capacitor/core';
import { PocketCodeBridge } from '../../native';

export interface ShareOutcome {
  ok: boolean;
  /** ok=false 时的界面提示。 */
  message?: string;
  /** 走了剪贴板兜底时为 true（Android 分享面板不可用的环境）。 */
  copied?: boolean;
  cancelled?: boolean;
  downloaded?: boolean;
}

export async function shareText(title: string, text: string): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title, text, dialogTitle: title });
      return { ok: true };
    } catch (error) {
      // 用户取消分享面板不算失败
      if (isUserCancel(error)) return { ok: true };
      return copyToClipboard(text);
    }
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, text });
      return { ok: true };
    } catch (error) {
      if (isUserCancel(error)) return { ok: true };
    }
  }
  return copyToClipboard(text);
}

function isUserCancel(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /cancel/i.test(error.message))
  );
}

async function copyToClipboard(text: string): Promise<ShareOutcome> {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, copied: true };
  } catch {
    return { ok: false, message: '分享失败，复制到剪贴板也不可用' };
  }
}

export async function copyText(text: string): Promise<ShareOutcome> {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, copied: true };
  } catch {
    return { ok: false, message: '复制失败：当前环境不允许访问剪贴板' };
  }
}

/** 文件分享不能回退成复制文本；Android 使用私有缓存和 FileProvider。 */
export async function shareArchive(name: string, bytes: Uint8Array): Promise<ShareOutcome> {
  try {
    if (bytes.byteLength > 16 * 1024 * 1024) return { ok: false, message: 'ZIP 超过 16 MiB 分享上限' };
    if (Capacitor.isNativePlatform()) {
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
      const { uri } = await PocketCodeBridge.writeShareArchive({ name, base64: btoa(parts.join('')) });
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: name, files: [uri], dialogTitle: '分享 ZIP 压缩包' });
      return { ok: true };
    }
    const file = new File([new Uint8Array(bytes).buffer], name, { type: 'application/zip' });
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: name });
        return { ok: true };
      } catch (error) { if (isUserCancel(error)) throw error; }
    }
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { ok: true, downloaded: true };
  } catch (error) {
    if (isUserCancel(error)) return { ok: true, cancelled: true };
    return { ok: false, message: error instanceof Error ? error.message : 'ZIP 分享失败，请重试' };
  }
}
