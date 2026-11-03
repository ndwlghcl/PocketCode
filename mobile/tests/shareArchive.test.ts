import { expect, test } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { archiveName, buildShareArchive } from '../src/features/sharing/archive';
import type { PreparedBundle } from '../src/features/sharing/prepareBundle';

function bundle(files: { path: string; content: string }[]): PreparedBundle {
  return { files, skipped: [], source: 'pc', fetchedAt: null, format: 'zip', bytes: 0 };
}

test('ZIP 可解压、保留中文相对目录和空文件；附准确的缓存来源说明', async () => {
  const prepared = bundle([{ path: '源码/工具.py', content: 'print("小岚")\r\n' }, { path: 'empty.txt', content: '' }]);
  prepared.files[0].source = 'cache'; prepared.files[0].version = 'sha256:abc';
  prepared.skipped = [{ path: 'logo.png', reason: '二进制' }];
  const archive = await buildShareArchive('学习项目', prepared);
  const files = unzipSync(archive);
  expect(strFromU8(files['源码/工具.py'])).toBe('print("小岚")\r\n');
  expect(files['empty.txt']).toHaveLength(0);
  const metadata = JSON.parse(strFromU8(files['PocketCode-分享说明.json']));
  expect(metadata.files[0]).toMatchObject({ path: '源码/工具.py', source: 'cache', version: 'sha256:abc' });
  expect(metadata.skipped).toEqual(prepared.skipped);
  expect(metadata.encoding).toBe('UTF-8');
});

test('来源说明不覆盖同名源码，使用真正的 DEFLATE 压缩', async () => {
  const archive = await buildShareArchive('demo', bundle([
    { path: 'PocketCode-分享说明.json', content: 'USER DATA' },
    { path: 'large.py', content: 'print(1)\n'.repeat(100_000) },
  ]));
  const files = unzipSync(archive);
  expect(strFromU8(files['PocketCode-分享说明.json'])).toBe('USER DATA');
  expect(JSON.parse(strFromU8(files['PocketCode-分享说明-1.json'])).project).toBe('demo');
  expect(archive.byteLength).toBeLessThan(30_000);
});

test.each(['../evil.py', '/abs.py', 'a/../bad', 'C:/file', 'a\\b', 'a//b', 'a\u0000b'])('拒绝危险 ZIP 路径 %j', async (path) => {
  await expect(buildShareArchive('demo', bundle([{ path, content: 'x' }]))).rejects.toThrow('不安全');
});

test('拒绝重复路径、文件目录重名与超额正文，清理下载文件名', async () => {
  await expect(buildShareArchive('x', bundle([{ path: 'a.py', content: '' }, { path: 'A.py', content: '' }]))).rejects.toThrow('重复');
  await expect(buildShareArchive('x', bundle([{ path: 'a', content: '' }, { path: 'a/b', content: '' }]))).rejects.toThrow('重名');
  await expect(buildShareArchive('x', bundle([{ path: 'big', content: 'x'.repeat(10 * 1024 * 1024 + 1) }]))).rejects.toThrow('10 MiB');
  expect(archiveName('../学习:项目')).not.toMatch(/[\\/:]/);
  expect(archiveName('')).toBe('PocketCode-project.zip');
});
