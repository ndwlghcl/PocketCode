import { describe, expect, it } from 'vitest';

import {
  buildMultiFileText,
  buildSnippetText,
  bundleTotalChars,
  detectSensitivePaths,
} from '../src/features/sharing/bundle';

describe('detectSensitivePaths（PRD §10 敏感提示）', () => {
  it('标记 .env/密钥/令牌类文件名；普通代码不标记', () => {
    const hits = detectSensitivePaths([
      'agents/search.py',
      '.env',
      'config/app.pem',
      'src/id_rsa_backup',
      'docs/token 设计.md',
      'main.py',
    ]);
    expect(hits.map((hit) => hit.path)).toEqual([
      '.env',
      'config/app.pem',
      'src/id_rsa_backup',
      'docs/token 设计.md',
    ]);
  });
});

describe('buildSnippetText（片段分享：代码+路径+行号）', () => {
  it('单行与多行片段', () => {
    expect(
      buildSnippetText({
        path: 'agents/search.py',
        startLine: 6,
        endLine: 6,
        code: 'def search(query: str) -> str:',
        source: 'pc',
        projectName: 'demo',
      }),
    ).toBe(
      '【代码片段】agents/search.py L6\n' +
        '来源：demo · 电脑当前版本\n' +
        '```\ndef search(query: str) -> str:\n```',
    );

    expect(
      buildSnippetText({
        path: 'a.py',
        startLine: 2,
        endLine: 3,
        code: 'line2\nline3\n',
        source: 'draft',
        projectName: 'demo',
      }),
    ).toContain('L2-L3');
    expect(
      buildSnippetText({
        path: 'a.py',
        startLine: 2,
        endLine: 3,
        code: 'line2\nline3\n',
        source: 'draft',
        projectName: 'demo',
      }),
    ).toContain('手机草稿（未保存到电脑）');
  });
});

describe('buildMultiFileText（多文件分享文本包）', () => {
  it('包含来源、清单、总大小与逐文件内容', () => {
    const text = buildMultiFileText({
      projectName: 'demo',
      source: 'cache',
      fetchedAt: '2026-10-25T18:00:00Z',
      files: [
        { path: 'a.py', content: 'print(1)\n' },
        { path: 'sub/b.js', content: 'let x = 2;\n' },
      ],
    });
    expect(text).toContain('【多文件分享】demo');
    expect(text).toContain('本地缓存（可能过期）（2026-10-25 18:00:00）');
    expect(text).toContain('文件（2 个，共 20 字符）');
    expect(text).toContain('- a.py');
    expect(text).toContain('## sub/b.js');
    expect(text).toContain('let x = 2;');
  });

  it('bundleTotalChars 求和', () => {
    expect(
      bundleTotalChars([
        { path: 'a', content: '12345' },
        { path: 'b', content: '678' },
      ]),
    ).toBe(8);
  });
});
