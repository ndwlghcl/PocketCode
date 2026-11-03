export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** 按行比较；大变更退化为整段增删，限制计算量，不阻塞手机。 */
export function lineDiff(before: string, after: string): { lines: DiffLine[]; coarse: boolean } {
  const a = before.split('\n'), b = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const x = a.slice(prefix, a.length - suffix), y = b.slice(prefix, b.length - suffix);
  const lines: DiffLine[] = [];
  let oldLine = 1, newLine = 1;
  const same = (text: string) => lines.push({ kind: 'same', text, oldLine: oldLine++, newLine: newLine++ });
  const remove = (text: string) => lines.push({ kind: 'removed', text, oldLine: oldLine++, newLine: null });
  const add = (text: string) => lines.push({ kind: 'added', text, oldLine: null, newLine: newLine++ });
  a.slice(0, prefix).forEach(same);
  const coarse = (x.length + 1) * (y.length + 1) > 1_000_000;
  if (coarse) { x.forEach(remove); y.forEach(add); }
  else {
    const width = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * width + j] = x[i] === y[j] ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { same(x[i]); i++; j++; }
      else if (i < x.length && (j === y.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) remove(x[i++]);
      else add(y[j++]);
    }
  }
  a.slice(a.length - suffix).forEach(same);
  return { lines, coarse };
}
