import { describe, expect, it, vi } from 'vitest';
import type { PythonContextResponse, Sha256Version } from '../src/api/types';
import type { PocketCodeClient } from '../src/api/client';
import { collectContextBundle, contextBundleText, initialContextSelection } from '../src/features/related/contextBundle';

const version = (digit: string) => `sha256:${digit.repeat(64)}` as Sha256Version;
function result(source: 'pc' | 'draft' | 'cache' = 'pc'): PythonContextResponse {
  return {
    path: 'main.py', source, source_version: version('1'), analyzer: 'python-ast-v1',
    generated_at: '2026-10-26T00:00:00Z', truncated: false, scanned_files: 3,
    definitions: [], references: [], warnings: ['动态导入不可识别'],
    related_files: [
      { path: 'tools.py', line: 1, version: version('2'), confidence: 'resolved', reasons: ['显式导入 tools'] },
      { path: 'same_name.py', line: 2, version: version('3'), confidence: 'candidate', reasons: ['同名候选'] },
      { path: 'credentials.py', line: 1, version: version('4'), confidence: 'resolved', reasons: ['显式导入'] },
    ],
  };
}
function client(versions: Record<string, Sha256Version>) {
  return { readFile: vi.fn(async (_project: string, path: string) => ({
    path, content: `# ${path}`, version: versions[path],
  })) } as unknown as PocketCodeClient;
}

describe('Python 关联分享', () => {
  it('候选与敏感文件默认不勾选', () => {
    expect([...initialContextSelection(result())]).toEqual(['main.py', 'tools.py']);
  });
  it('保留入口草稿，其他文件读取电脑版并分别标明来源和版本', async () => {
    const api = client({ 'tools.py': version('2') });
    const response = result('draft');
    const request = { path: 'main.py', content: '# draft idea', symbol: 'run', line: 3 };
    const files = await collectContextBundle(api, 'p', request, response, new Set(['main.py', 'tools.py']));
    expect(api.readFile).toHaveBeenCalledTimes(1);
    expect(files[0].content).toBe('# draft idea');
    expect(files.map((file) => file.source)).toEqual(['draft', 'pc']);
    const text = contextBundleText('demo', response, files, request);
    expect(text).toContain('选中符号：run');
    expect(text).toContain('手机草稿');
    expect(text).toContain('电脑当前版本');
    expect(text).toContain(version('2'));
    expect(text).toContain('动态导入不可识别');
  });
  it('缓存入口不会被误标为草稿或重新从电脑加载', async () => {
    const api = client({});
    const files = await collectContextBundle(api, 'p', { path: 'main.py', content: 'cached', source: 'cache' },
      result('cache'), new Set(['main.py']));
    expect(files[0].source).toBe('cache');
    expect(api.readFile).not.toHaveBeenCalled();
  });
  it('电脑版入口或关联文件在分析后变化时要求重新分析', async () => {
    const api = client({ 'main.py': version('9'), 'tools.py': version('9') });
    for (const path of ['main.py', 'tools.py']) {
      await expect(collectContextBundle(api, 'p', { path: 'main.py' }, result(), new Set([path])))
        .rejects.toThrow('在分析后已变化');
    }
  });
  it('空选择和超出大小预算不会生成不完整但看似成功的文本包', async () => {
    await expect(collectContextBundle(client({}), 'p', { path: 'main.py' }, result(), new Set()))
      .rejects.toThrow('至少选择');
    await expect(collectContextBundle(client({}), 'p', { path: 'main.py', content: '123456' }, result('draft'), new Set(['main.py']), 3))
      .rejects.toThrow('超过');
  });
});
