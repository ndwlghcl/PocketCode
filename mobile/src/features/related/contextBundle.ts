import type { PythonContextRequest, PythonContextResponse } from '../../api/types';
import type { PocketCodeClient } from '../../api/client';
import { saveCachedFile } from '../../storage/cacheStore';
import { buildMultiFileText, detectSensitivePaths, type BundleFile } from '../sharing/bundle';

/** 默认不勾选同名候选和疑似敏感路径；用户仍可主动选择后预览。 */
export function initialContextSelection(result: PythonContextResponse): Set<string> {
  const paths = [result.path, ...result.related_files
    .filter((file) => file.confidence === 'resolved').map((file) => file.path)];
  const sensitive = new Set(detectSensitivePaths(paths).map((hit) => hit.path));
  return new Set(paths.filter((path) => !sensitive.has(path)));
}

/** 分析和读取之间可能发生修改；版本不一致时要求重新分析，不分享错位上下文。 */
export async function collectContextBundle(
  client: PocketCodeClient,
  projectId: string,
  request: PythonContextRequest,
  result: PythonContextResponse,
  selected: ReadonlySet<string>,
  maxChars = 200_000,
): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  let total = 0;
  const entries = [
    { path: result.path, version: result.source_version, reasons: ['当前分析入口'] },
    ...result.related_files,
  ];
  for (const entry of entries) {
    if (!selected.has(entry.path)) continue;
    let content: string;
    let source = result.source;
    if (entry.path === result.path && request.content !== undefined) {
      content = request.content;
    } else {
      const data = await client.readFile(projectId, entry.path);
      if (data.version !== entry.version) {
        throw new Error(`${entry.path} 在分析后已变化，请重新分析再分享。`);
      }
      content = data.content;
      source = 'pc';
      void saveCachedFile(projectId, data).catch(() => undefined);
    }
    total += content.length;
    if (total > maxChars) throw new Error('所选正文超过 20 万字符，请减少勾选文件。');
    files.push({ path: entry.path, content, source, version: entry.version, reason: entry.reasons.join('；') });
  }
  if (!files.length) throw new Error('请至少选择一个文件。');
  return files;
}

export function contextBundleText(projectName: string, result: PythonContextResponse, files: BundleFile[], request?: PythonContextRequest): string {
  return buildMultiFileText({
    projectName, files, source: result.source, fetchedAt: result.generated_at,
    context: [`入口：${result.path}`, ...(request?.symbol ? [`选中符号：${request.symbol}（第 ${request.line ?? '?'} 行）`] : []),
      '各文件是分析时的版本快照，后续修改不会自动进入本包。',
      '仅为 Python 静态关联建议，不代表完整运行时调用图。',
      ...result.warnings].join('\n'),
  });
}
