import { useEffect, useRef } from 'react';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  LanguageDescription,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';
import { identifierAt } from './outline';

/** 诊断（S4d）：与合同 Diagnostic 对齐的子集。 */
export interface Diagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning';
}

/** 波浪线标记：编辑过程中随文档变更自动映射位置。 */
const setDiagnosticsEffect = StateEffect.define<DecorationSet>();
const diagnosticsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnosticsEffect)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface Props {
  doc: string;
  readOnly: boolean;
  /** 文件名/路径：按扩展名选择语法高亮语言。 */
  fileName: string;
  /** 视觉折行（PRD §4.2：默认开启，可关闭切换横向滚动）。 */
  wrap: boolean;
  /** 进入时的滚动位置（阅读位置恢复）；null 表示无记录。 */
  initialScrollTop?: number | null;
  /** 定位请求：{line: 1-based 行号, nonce: 递增序号}；nonce 变化即重新跳转
   *  （搜索结果定位、大纲/符号跳转共用）。null 表示不跳。 */
  scrollRequest?: { line: number; nonce: number } | null;
  /** 诊断波浪线（S4d）：line 1-based，column 1-based。 */
  diagnostics?: Diagnostic[];
  /** 只读模式选区变化回调（S4f 片段分享）：有非空选区时上抛，清空传 null。 */
  onSelection?: (selection: { text: string; startLine: number; endLine: number } | null) => void;
  /** 只读模式长按符号回调（Android WebView 长按触发 contextmenu）。 */
  onSymbolPress?: (symbol: string, line: number) => void;
  /** 编辑模式内容变化回调。 */
  onDocChange?: (value: string) => void;
  /** 内部 scroller 滚动回调（阅读位置记录）。 */
  onScrollTop?: (scrollTop: number) => void;
  /** 失焦回调（编辑模式落草稿的安全网）。 */
  onBlur?: () => void;
  className?: string;
}

/** 高亮用类映射：颜色在 theme.css 里定义（.tok-*，深浅色各一套）。 */
const pocketHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.self], class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'tok-string' },
  { tag: [t.number, t.bool, t.null], class: 'tok-number' },
  { tag: [t.comment, t.meta, t.docComment], class: 'tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-func' },
  { tag: [t.definition(t.variableName)], class: 'tok-def' },
  { tag: [t.className, t.namespace], class: 'tok-class' },
  { tag: [t.typeName], class: 'tok-type' },
  { tag: [t.propertyName], class: 'tok-prop' },
  { tag: [t.variableName], class: 'tok-var' },
  { tag: [t.operator], class: 'tok-op' },
  { tag: [t.punctuation, t.separator, t.bracket], class: 'tok-punc' },
  { tag: [t.heading], class: 'tok-def' },
  { tag: [t.link, t.url], class: 'tok-string' },
]);

/**
 * CodeMirror 6 封装（S4a）：阅读与编辑共用。
 * - 滚动容器是组件内部 scroller，阅读位置由外层持久化（跨重启）；
 * - readOnly / 折行 / 语言走 compartment 动态重配，不重建视图；
 * - doc 受控：prop 变化且与视图不同时整体替换（草稿切换、加载电脑版），
 *   打字回流的相同内容不触发 dispatch，避免打断输入法。
 */
export function CodeEditor({
  doc,
  readOnly,
  fileName,
  wrap,
  initialScrollTop,
  scrollRequest,
  diagnostics,
  onSymbolPress,
  onSelection,
  onDocChange,
  onScrollTop,
  onBlur,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  // 回调走 ref：视图闭包始终读最新函数，不因回调身份重建扩展
  const changeRef = useRef(onDocChange);
  changeRef.current = onDocChange;
  const scrollRef = useRef(onScrollTop);
  scrollRef.current = onScrollTop;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onSymbolPressRef = useRef(onSymbolPress);
  onSymbolPressRef.current = onSymbolPress;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;

  // ---- 创建视图（仅一次）----
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of('    '),
          syntaxHighlighting(pocketHighlight),
          languageCompartment.current.of([]),
          wrapCompartment.current.of([]),
          readOnlyCompartment.current.of([
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ]),
          diagnosticsField,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              changeRef.current?.(update.state.doc.toString());
            }
            // 只读模式的选区上抛（片段分享）；编辑模式不触发
            if (onSelectionRef.current && readOnlyRef.current) {
              const range = update.state.selection.main;
              if (!range.empty) {
                const startLine = update.state.doc.lineAt(range.from).number;
                const endLine = update.state.doc.lineAt(range.to).number;
                onSelectionRef.current({
                  text: update.state.sliceDoc(range.from, range.to),
                  startLine,
                  endLine,
                });
              } else {
                onSelectionRef.current(null);
              }
            }
          }),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              changeRef.current?.(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.scrollDOM.addEventListener('scroll', () => {
      scrollRef.current?.(view.scrollDOM.scrollTop);
    });
    view.dom.addEventListener('focusout', () => blurRef.current?.());
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- doc 同步：外部重置（草稿切换/加载电脑版）时整体替换 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== doc) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
      });
      view.scrollDOM.scrollTop = 0;
    }
  }, [doc]);

  // ---- 只读/编辑切换 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // ---- 折行切换 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);

  // ---- 语言：按文件名异步加载语法包 ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const view = viewRef.current;
      if (!view) return;
      const description = LanguageDescription.matchFilename(languages, fileName);
      if (!description) {
        view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
        return;
      }
      try {
        const support = await description.load();
        if (!cancelled && viewRef.current) {
          viewRef.current.dispatch({
            effects: languageCompartment.current.reconfigure(support),
          });
        }
      } catch {
        // 语言包加载失败（不应发生，资源为本地打包）：退化为无高亮
        if (!cancelled && viewRef.current) {
          viewRef.current.dispatch({
            effects: languageCompartment.current.reconfigure([]),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  // ---- 阅读位置恢复：视图布局完成后跳到上次位置 ----
  useEffect(() => {
    if (initialScrollTop == null) return;
    const view = viewRef.current;
    if (!view) return;
    const target = initialScrollTop;
    const raf = requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [initialScrollTop]);

  // ---- 定位请求：nonce 变化即重新跳转（搜索/大纲/符号共用）----
  useEffect(() => {
    if (!scrollRequest) return;
    const view = viewRef.current;
    if (!view) return;
    const lineNo = Math.max(1, Math.min(scrollRequest.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNo);
    const raf = requestAnimationFrame(() => {
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollRequest]);

  // ---- 诊断波浪线（S4d）：按 line/column 定位词边界打标记 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!diagnostics || diagnostics.length === 0) {
      view.dispatch({ effects: setDiagnosticsEffect.of(Decoration.none) });
      return;
    }
    const builder: { from: number; to: number; class: string }[] = [];
    for (const diagnostic of diagnostics) {
      const lineNo = Math.max(1, Math.min(diagnostic.line, view.state.doc.lines));
      const line = view.state.doc.line(lineNo);
      const col = Math.max(1, diagnostic.column);
      const from = Math.min(line.from + col - 1, line.to);
      // 波浪线覆盖该处的标识符；取不到词（如括号）时退化为该处之后 8 个字符
      const rest = view.state.sliceDoc(from, line.to);
      let to = Math.min(from + 8, line.to);
      for (let offset = 0; offset < rest.length; offset++) {
        if (/[\w$]/.test(rest[offset])) {
          let end = offset + 1;
          while (end < rest.length && /[\w$]/.test(rest[end])) end++;
          to = from + end;
          break;
        }
      }
      builder.push({
        from,
        to,
        class: diagnostic.severity === 'error' ? 'diagnostic-error' : 'diagnostic-warning',
      });
    }
    view.dispatch({
      effects: setDiagnosticsEffect.of(
        Decoration.set(
          builder
            .sort((a, b) => a.from - b.from)
            .map((range) =>
              Decoration.mark({ class: range.class }).range(range.from, range.to),
            ),
        ),
      ),
    });
  }, [diagnostics]);

  // ---- 只读模式长按取词：Android 长按触发 contextmenu，取词后交给上层 ----
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const handler = (event: MouseEvent) => {
      if (!readOnlyRef.current || !onSymbolPressRef.current) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return;
      const line = view.state.doc.lineAt(pos);
      const symbol = identifierAt(line.text, pos - line.from);
      if (!symbol) return;
      event.preventDefault();
      onSymbolPressRef.current(symbol, line.number);
    };
    view.dom.addEventListener('contextmenu', handler);
    return () => view.dom.removeEventListener('contextmenu', handler);
  }, []);

  return <div ref={hostRef} className={`cmhost ${className ?? ''}`} />;
}
