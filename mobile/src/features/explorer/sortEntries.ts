/**
 * 目录条目排序：文件夹在前、文件在后，各自按名称排序（PRD v1.1 确认决策）。
 * 最近阅读只做标记，不影响排序，因此排序是纯函数、无状态。
 */

import type { ManifestNode } from '../../api/types';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortEntries(entries: readonly ManifestNode[]): ManifestNode[] {
  return [...entries].sort((a, b) => {
    const rankA = a.type === 'dir' ? 0 : 1;
    const rankB = b.type === 'dir' ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return collator.compare(a.name, b.name);
  });
}
