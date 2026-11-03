import { expect, test } from 'vitest';
import type { ManifestDir, ManifestFile } from '../src/api/types';
import { indexShareTree, selectionState, toggleSharePaths, visibleShareRows } from '../src/features/sharing/selection';

const file = (path: string): ManifestFile => ({ type: 'file', name: path.split('/').pop()!, path, size: 5, mtime: '', version: 'sha256:a', read_only: false });
const root: ManifestDir = { type: 'dir', name: '', path: '', children: [
  { type: 'dir', name: 'src', path: 'src', children: [file('src/a.py'), { type: 'dir', name: 'tools', path: 'src/tools', children: [file('src/tools/b.py')] }] },
  { type: 'dir', name: 'src2', path: 'src2', children: [file('src2/c.py')] }, file('README.md'),
] };

test('文件夹一次选择包括未展开的子目录，不混入同前缀的兄弟目录', () => {
  const { tree } = indexShareTree(root);
  const folder = tree[0];
  if (folder.type !== 'dir') throw new Error('expected folder');
  expect(visibleShareRows(tree, new Set(), '').map((row) => row.path)).toEqual(['src', 'src2', 'README.md']);
  const selected = toggleSharePaths(new Set(['README.md']), folder.paths);
  expect([...selected]).toEqual(['README.md', 'src/a.py', 'src/tools/b.py']);
  expect(selectionState(selected, folder.paths)).toBe(true);
  expect([...toggleSharePaths(selected, folder.paths)]).toEqual(['README.md']);
});

test('单文件取消后父目录是部分选中，再点父目录补齐；空目录不误选', () => {
  expect(selectionState(new Set(['src/a.py']), ['src/a.py', 'src/tools/b.py'])).toBe('mixed');
  expect([...toggleSharePaths(new Set(['src/a.py']), ['src/a.py', 'src/tools/b.py'])]).toEqual(['src/a.py', 'src/tools/b.py']);
  expect(selectionState(new Set(), [])).toBe(false);
});

test('搜索自动展开命中路径，文件夹选择范围仍是完整子树', () => {
  const { tree, files } = indexShareTree(root);
  expect(visibleShareRows(tree, new Set(), 'b.py').map((row) => row.path)).toEqual(['src', 'src/tools', 'src/tools/b.py']);
  expect(files.map((entry) => entry.path)).toEqual(['src/a.py', 'src/tools/b.py', 'src2/c.py', 'README.md']);
});
