import { expect, test } from 'vitest';
import { lineDiff } from '../src/features/editor/lineDiff';

test.each([
  ['', ''], ['a\nb\nc\n', 'a\nB\nc\n'], ['', 'new'], ['old', ''],
  ['a\nb\na', 'a\na\nb'], ['a\n', 'a'], ['相同\n旧', '相同\n新'],
])('逐行差异能重建两边正文：%j -> %j', (before, after) => {
  const { lines } = lineDiff(before, after);
  expect(lines.filter((row) => row.kind !== 'added').map((row) => row.text).join('\n')).toBe(before);
  expect(lines.filter((row) => row.kind !== 'removed').map((row) => row.text).join('\n')).toBe(after);
});

test('行号、插入与删除标记准确', () => {
  expect(lineDiff('a\nb\nc', 'a\nx\nc').lines).toEqual([
    { kind: 'same', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'removed', text: 'b', oldLine: 2, newLine: null },
    { kind: 'added', text: 'x', oldLine: null, newLine: 2 },
    { kind: 'same', text: 'c', oldLine: 3, newLine: 3 },
  ]);
});

test('大规模变更降级为整段比较，仍能完整重建原文', () => {
  const before = Array.from({ length: 1100 }, (_, i) => `old ${i}`).join('\n');
  const after = before.replaceAll('old', 'new');
  const result = lineDiff(before, after);
  expect(result.coarse).toBe(true);
  expect(result.lines.filter((row) => row.kind !== 'added').map((row) => row.text).join('\n')).toBe(before);
  expect(result.lines.filter((row) => row.kind !== 'removed').map((row) => row.text).join('\n')).toBe(after);
});
