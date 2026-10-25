/**
 * 「给哥哥看」分享内容生成（S4f，PRD §8）：纯函数。
 *
 * 规则（PRD §8.1/§8.2 + §10）：
 * - 片段 = 代码 + 文件路径 + 行号；单文件/多文件 = 保留相对路径的阅读文档；
 * - **来源必须明确标注**（电脑版 / 本地缓存 / 草稿），避免 AI 把缓存当最新；
 * - 分享前要展示清单/总大小，并给敏感文件名提示（.env/密钥/令牌类）；
 * - 临时 ZIP 不做（多文件默认文本包，可读性优先）；智能关联在 S5。
 */

export type ShareSource = 'pc' | 'cache' | 'draft';

export const SOURCE_LABEL: Record<ShareSource, string> = {
  pc: '电脑当前版本',
  cache: '本地缓存（可能过期）',
  draft: '手机草稿（未保存到电脑）',
};

/** 文件名里的敏感特征（PRD §10：默认不分享 .env/私钥/令牌类）。 */
const SENSITIVE_NAME_PATTERN =
  /(^|[/\\])(\.env|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa[^/\\]*|credentials|secrets?|password|token)[^/\\]*$/i;

export interface SensitiveHit {
  path: string;
  reason: string;
}

export function detectSensitivePaths(paths: string[]): SensitiveHit[] {
  return paths
    .filter((path) => SENSITIVE_NAME_PATTERN.test(path))
    .map((path) => ({ path, reason: '文件名疑似敏感（环境变量/密钥/令牌），请确认是否包含凭据' }));
}

export interface SnippetShare {
  path: string;
  /** 1-based；单行片段时 start === end。 */
  startLine: number;
  endLine: number;
  code: string;
  source: ShareSource;
  projectName: string;
}

export function buildSnippetText(share: SnippetShare): string {
  const lineHint =
    share.startLine === share.endLine
      ? `L${share.startLine}`
      : `L${share.startLine}-L${share.endLine}`;
  return (
    `【代码片段】${share.path} ${lineHint}\n` +
    `来源：${share.projectName} · ${SOURCE_LABEL[share.source]}\n` +
    '```' + '\n' +
    share.code.replace(/\n$/, '') +
    '\n' +
    '```'
  );
}

export interface BundleFile {
  path: string;
  content: string;
}

export interface MultiFileBundle {
  projectName: string;
  files: BundleFile[];
  source: ShareSource;
  /** 电脑版本/缓存同步时间（ISO，可为空）。 */
  fetchedAt?: string | null;
}

export function bundleTotalChars(files: BundleFile[]): number {
  return files.reduce((sum, file) => sum + file.content.length, 0);
}

/** 多文件分享文本包：阅读优先的上下文文档。 */
export function buildMultiFileText(bundle: MultiFileBundle): string {
  const timeHint = bundle.fetchedAt
    ? bundle.fetchedAt.slice(0, 19).replace('T', ' ')
    : '未知时间';
  const header =
    `【多文件分享】${bundle.projectName}\n` +
    `来源：${SOURCE_LABEL[bundle.source]}（${timeHint}）\n` +
    `文件（${bundle.files.length} 个，共 ${bundleTotalChars(bundle.files)} 字符）：\n` +
    bundle.files.map((file) => `- ${file.path}`).join('\n') +
    '\n';
  const sections = bundle.files
    .map(
      (file) =>
        `\n## ${file.path}\n` +
        '```\n' +
        file.content.replace(/\n$/, '') +
        '\n' +
        '```',
    )
    .join('\n');
  return header + sections + '\n';
}
