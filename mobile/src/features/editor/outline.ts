/**
 * 代码大纲与符号导航（S4c）：纯函数，全部基于当前文件内容本地计算——
 * 离线可用、零网络往返。跨文件的语义跳转（引用/调用图）是 S5 智能关联，
 * 这里只做本文件内的定义跳转与引用查找（PRD §4.2/§4.3 的首版口径）。
 *
 * 大纲支持（尽力而为）：Python（def/class + 缩进判定方法）、
 * JS/TS（function/class/const 箭头函数）、Java/C# 风格（class/interface/enum）、
 * Markdown（标题）。其他语言没有大纲，不影响使用。
 */

export interface OutlineSymbol {
  name: string;
  kind: 'class' | 'function' | 'method' | 'heading';
  /** 1-based 行号。 */
  line: number;
  indent: number;
}

interface Rule {
  regex: RegExp;
  kind: OutlineSymbol['kind'];
  /** 名字所在捕获组序号。 */
  nameGroup: number;
  /** 缩进所在捕获组序号（可选；无缩进概念的语言省略）。 */
  indentGroup?: number;
}

const PYTHON_RULES: Rule[] = [
  { regex: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 2, indentGroup: 1 },
  { regex: /^(\s*)def\s+([A-Za-z_]\w*)/, kind: 'function', nameGroup: 2, indentGroup: 1 },
];

const JS_RULES: Rule[] = [
  { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 1 },
  { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/, kind: 'function', nameGroup: 1 },
  { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|([A-Za-z_][\w.]*)\s*=>)/, kind: 'function', nameGroup: 1 },
];

const JAVA_RULES: Rule[] = [
  { regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:final\s+|abstract\s+|static\s+)*(?:class|interface|enum)\s+([A-Za-z_]\w*)/, kind: 'class', nameGroup: 1 },
  // 方法：修饰符+类型+名字+(...){ 且行尾开括号；保守匹配，宁可漏不可错
  { regex: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*[\w<>\[\],.\s]+\s([A-Za-z_]\w*)\s*\([^;]*\)\s*\{\s*$/, kind: 'function', nameGroup: 1 },
];

const MARKDOWN_RULES: Rule[] = [
  { regex: /^(#{1,6})\s+(.+?)\s*$/, kind: 'heading', nameGroup: 2 },
];

function rulesFor(fileName: string): Rule[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.py')) return PYTHON_RULES;
  if (/\.(jsx?|tsx?|mjs|cjs)$/.test(lower)) return JS_RULES;
  if (/\.(java|cs|kt|go)$/.test(lower)) return JAVA_RULES;
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return MARKDOWN_RULES;
  return [];
}

export function extractOutline(content: string, fileName: string): OutlineSymbol[] {
  const rules = rulesFor(fileName);
  if (rules.length === 0) return [];
  const symbols: OutlineSymbol[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      const match = rule.regex.exec(line);
      if (!match) continue;
      const name = match[rule.nameGroup] ?? '';
      const indent = rule.indentGroup ? (match[rule.indentGroup]?.length ?? 0) : 0;
      if (!name.trim()) continue;
      symbols.push({
        name: name.trim(),
        kind: rule.kind === 'function' && indent > 0 ? 'method' : rule.kind,
        line: i + 1,
        indent,
      });
      break;
    }
  }
  return symbols;
}

/** 转义正则元字符后做词边界匹配。 */
function wordRegex(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`);
}

/**
 * 本文件内的定义行：def/class/function/const 等定义模式里出现该符号。
 * 返回升序行号。
 */
export function findDefinitions(
  content: string,
  fileName: string,
  symbol: string,
): number[] {
  if (!symbol) return [];
  const outline = extractOutline(content, fileName).filter(
    (entry) => entry.kind !== 'heading' && entry.name === symbol,
  );
  return [...new Set(outline.map((entry) => entry.line))].sort((a, b) => a - b);
}

/** 本文件内的全部引用行（词边界匹配），升序。 */
export function findReferences(content: string, symbol: string): number[] {
  if (!symbol) return [];
  const regex = wordRegex(symbol);
  const lines: number[] = [];
  content.split('\n').forEach((line, index) => {
    if (regex.test(line)) lines.push(index + 1);
  });
  return lines;
}

/** 从行文本中取光标/长按位置所在的标识符。 */
export function identifierAt(lineText: string, column: number): string | null {
  const isWordChar = (ch: string) => /[\w$]/.test(ch);
  if (column < 0 || column >= lineText.length) return null;
  if (!isWordChar(lineText[column])) return null;
  let start = column;
  let end = column + 1;
  while (start > 0 && isWordChar(lineText[start - 1])) start--;
  while (end < lineText.length && isWordChar(lineText[end])) end++;
  const word = lineText.slice(start, end);
  return /^\d/.test(word) ? null : word;
}
