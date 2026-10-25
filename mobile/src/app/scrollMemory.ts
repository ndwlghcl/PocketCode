/**
 * 滚动位置记忆（PRD §4.2/§4.3）：列表页与文件阅读位置按 key 记录，
 * 组件重建（返回导航）后原位恢复。内存级，应用重启后清零。
 */

const positions = new Map<string, number>();

function scrollTop(): number {
  const element = document.scrollingElement;
  return element ? element.scrollTop : window.scrollY;
}

function applyScroll(top: number): void {
  const element = document.scrollingElement;
  if (element) element.scrollTop = top;
  window.scrollTo(0, top);
}

/** 记录窗口滚动位置（列表页用）。 */
export function saveWindowScroll(key: string): void {
  if (typeof document === 'undefined') return;
  positions.set(key, scrollTop());
}

/** 恢复窗口滚动位置；多次尝试确保列表按缓存渲染后再定位。 */
export function restoreWindowScroll(key: string): void {
  const y = positions.get(key);
  if (!y) return;
  const attempt = (tries: number) => {
    requestAnimationFrame(() => {
      applyScroll(y);
      if (tries > 0) setTimeout(() => attempt(tries - 1), 60);
    });
  };
  attempt(3);
}

/** 记录/恢复元素内部滚动位置（文件阅读视图用）。 */
export function saveScrollValue(key: string, top: number): void {
  positions.set(key, top);
}

export function restoreScrollValue(
  key: string,
  apply: (top: number) => void,
): void {
  const top = positions.get(key);
  if (!top) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => apply(top));
  });
}
