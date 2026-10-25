import { describe, expect, it } from 'vitest';

import {
  extractOutline,
  findDefinitions,
  findReferences,
  identifierAt,
} from '../src/features/editor/outline';

describe('extractOutline（S4c 大纲）', () => {
  it('Python：class/顶层函数/缩进方法', () => {
    const code = [
      'import os',
      '',
      'class Agent:',
      '    def run(self):',
      '        pass',
      '',
      'def helper():',
      '    pass',
    ].join('\n');
    expect(extractOutline(code, 'agent.py')).toEqual([
      { name: 'Agent', kind: 'class', line: 3, indent: 0 },
      { name: 'run', kind: 'method', line: 4, indent: 4 },
      { name: 'helper', kind: 'function', line: 7, indent: 0 },
    ]);
  });

  it('JS/TS：function/class/const 箭头函数', () => {
    const code = [
      'export class Client {',
      '  async fetchAll() {}',
      '}',
      'function helper() {}',
      'export const main = async () => {};',
      'const add = (a, b) => a + b;',
    ].join('\n');
    const outline = extractOutline(code, 'client.ts');
    expect(outline.map((s) => [s.name, s.kind])).toEqual([
      ['Client', 'class'],
      ['helper', 'function'],
      ['main', 'function'],
      ['add', 'function'],
    ]);
  });

  it('Markdown：标题做大纲', () => {
    const md = '# 标题\n正文\n## 小节\n';
    expect(extractOutline(md, 'notes.md')).toEqual([
      { name: '标题', kind: 'heading', line: 1, indent: 0 },
      { name: '小节', kind: 'heading', line: 3, indent: 0 },
    ]);
  });

  it('不支持的语言返回空数组', () => {
    expect(extractOutline('GET /path\n', 'routes.yaml')).toEqual([]);
  });
});

describe('findDefinitions / findReferences（S4c 符号导航）', () => {
  const code = [
    'def handler(req):',
    '    return process(req)',
    '',
    'def process(req):',
    '    return handler(req)',
  ].join('\n');

  it('定义行按大纲命中；引用包含全部词边界出现', () => {
    expect(findDefinitions(code, 'app.py', 'process')).toEqual([4]);
    expect(findReferences(code, 'process')).toEqual([2, 4]);
    // 递归：handler 的定义在 1，引用在 1 和 5
    expect(findDefinitions(code, 'app.py', 'handler')).toEqual([1]);
    expect(findReferences(code, 'handler')).toEqual([1, 5]);
  });

  it('词边界：不匹配更长的标识符', () => {
    const src = 'value = 1\nvalues = 2\n';
    expect(findReferences(src, 'value')).toEqual([1]);
  });

  it('查不到定义返回空数组（界面据此明确说明）', () => {
    expect(findDefinitions(code, 'app.py', 'missing')).toEqual([]);
    expect(findReferences(code, 'missing')).toEqual([]);
  });
});

describe('identifierAt（长按取词）', () => {
  it('取标识符边界；数字与非单词字符返回 null', () => {
    expect(identifierAt('result = compute_something(x)', 15)).toBe('compute_something');
    expect(identifierAt('result = compute_something(x)', 0)).toBe('result');
    expect(identifierAt('a.b.c', 2)).toBe('b');
    expect(identifierAt('   foo', 1)).toBeNull();
    expect(identifierAt('abc 123 def', 5)).toBeNull();
    expect(identifierAt('x', 10)).toBeNull();
  });
});
