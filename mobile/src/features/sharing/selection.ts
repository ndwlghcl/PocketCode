import type { ManifestDir } from '../../api/types';

export interface ShareFileEntry { type: 'file'; path: string; name: string; size: number; depth: number }
export interface ShareFolderEntry { type: 'dir'; path: string; name: string; paths: string[]; children: ShareEntry[]; depth: number }
export type ShareEntry = ShareFileEntry | ShareFolderEntry;

export function indexShareTree(root: ManifestDir): { tree: ShareEntry[]; files: ShareFileEntry[] } {
  const files: ShareFileEntry[] = [];
  const visit = (node: ManifestDir, depth: number): ShareEntry[] => node.children.map((child) => {
    if (child.type === 'file') {
      const file: ShareFileEntry = { type: 'file', path: child.path, name: child.name, size: child.size, depth };
      files.push(file);
      return file;
    }
    const children = visit(child, depth + 1);
    return { type: 'dir', path: child.path, name: child.name, children, depth,
      paths: children.flatMap((entry) => entry.type === 'file' ? [entry.path] : entry.paths) };
  });
  return { tree: visit(root, 0), files };
}

export function visibleShareRows(tree: ShareEntry[], expanded: ReadonlySet<string>, needle: string): ShareEntry[] {
  const rows: ShareEntry[] = [];
  for (const entry of tree) {
    if (entry.type === 'file') {
      if (!needle || entry.path.toLowerCase().includes(needle)) rows.push(entry);
    } else {
      const children = needle || expanded.has(entry.path) ? visibleShareRows(entry.children, expanded, needle) : [];
      if (needle && !entry.path.toLowerCase().includes(needle) && children.length === 0) continue;
      rows.push(entry, ...children);
    }
  }
  return rows;
}

export function selectionState(selected: ReadonlySet<string>, paths: string[]): boolean | 'mixed' {
  const count = paths.reduce((sum, path) => sum + Number(selected.has(path)), 0);
  return count === 0 ? false : count === paths.length ? true : 'mixed';
}

export function toggleSharePaths(selected: ReadonlySet<string>, paths: string[]): Set<string> {
  const next = new Set(selected);
  const remove = paths.length > 0 && paths.every((path) => next.has(path));
  for (const path of paths) { if (remove) next.delete(path); else next.add(path); }
  return next;
}
