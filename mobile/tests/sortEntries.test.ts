import { describe, expect, it } from 'vitest';

import type { ManifestNode } from '../src/api/types';
import { sortEntries } from '../src/features/explorer/sortEntries';

function dir(name: string): ManifestNode {
  return { type: 'dir', name, path: name, children: [] };
}

function file(name: string): ManifestNode {
  return {
    type: 'file',
    name,
    path: name,
    size: 1,
    mtime: '2026-10-24T00:00:00Z',
    version: 'sha256:aa',
    read_only: false,
  };
}

describe('sortEntries（PRD：文件夹前、文件后、各自名称排序）', () => {
  it('目录排前、文件排后，各组内部按名称排序', () => {
    const input = [file('zeta.py'), dir('beta'), file('alpha.py'), dir('alpha')];
    const sorted = sortEntries(input);
    expect(sorted.map((n) => `${n.type}:${n.name}`)).toEqual([
      'dir:alpha',
      'dir:beta',
      'file:alpha.py',
      'file:zeta.py',
    ]);
  });

  it('不修改输入数组（纯函数）', () => {
    const input = [file('b'), dir('a')];
    const snapshot = [...input];
    sortEntries(input);
    expect(input.map((n) => n.name)).toEqual(snapshot.map((n) => n.name));
  });

  it('数字感知排序：v2 排在 v10 前', () => {
    const input = [file('v10.py'), file('v2.py')];
    expect(sortEntries(input).map((n) => n.name)).toEqual(['v2.py', 'v10.py']);
  });
});
