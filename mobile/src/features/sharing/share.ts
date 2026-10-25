/**
 * 系统分享封装（S4f「给哥哥看」）：Android 原生分享面板；浏览器开发模式
 * 退化为 navigator.share，再退化为复制到剪贴板。绝不静默丢内容——
 * 失败时返回 false 让界面给出提示。
 */

import { Capacitor } from '@capacitor/core';

export interface ShareOutcome {
  ok: boolean;
  /** ok=false 时的界面提示。 */
  message?: string;
  /** 走了剪贴板兜底时为 true（Android 分享面板不可用的环境）。 */
  copied?: boolean;
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
