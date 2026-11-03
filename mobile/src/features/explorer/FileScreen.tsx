import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Diagnostic, FileContentResponse, PythonLocation, PythonRelatedFile } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { saveCachedFile } from '../../storage/cacheStore';
import { CodeEditor } from '../editor/CodeEditor';
import {
  extractOutline,
  findDefinitions,
  findReferences,
  type OutlineSymbol,
} from '../editor/outline';
import {
  buildMultiFileText,
  buildSnippetText,
  type ShareSource,
} from '../sharing/bundle';
import { copyText, shareText } from '../sharing/share';
import { ReadingTools } from './ReadingTools';
import { PythonContextPanel, type ContextQuery, type ContextView } from '../related/PythonContextPanel';
import {
  createPositionSaver,
  loadReadPosition,
} from '../../storage/readPositionStore';
import { useAppearance } from '../../app/Appearance';
import { ConflictDiff } from './ConflictDiff';
import { Icon } from '../../ui/Icon';
import { ActionSheet, MenuItem } from '../../ui/Controls';
import {
  loadDrafts,
  newDraftId,
  removeDraft,
  renameDraft,
  setActiveDraft,
  upsertDraft,
  type FileDraft,
  type StoredDrafts,
} from '../../storage/draftStore';

interface Props {
  client: PocketCodeClient | null;
  projectId: string;
  initialData: FileContentResponse;
  /** true = 内容来自本地缓存（离线或电脑暂不可达）。 */
  fromCache?: boolean;
  cachedAt?: string;
  online: boolean;
  /** 授权被撤销：不得保存、不得刷新电脑内容。 */
  revoked: boolean;
  onBack: () => void;
  /** 注册 Android 返回键拦截器：返回 true 表示已在本页处理。 */
  registerBackGuard: (guard: (() => boolean) | null) => void;
  /** 进入/退出全屏阅读时通知根布局（隐藏状态栏与页边距）。 */
  onImmersiveChange?: (value: boolean) => void;
  /** 搜索结果定位：打开后跳到的行（1-based，仅阅读）。 */
  initialLine?: number;
  projectName?: string;
  onOpenRelated?: (data: FileContentResponse, line: number,
    origin: { data: FileContentResponse; mode: 'read' | 'edit'; fromCache?: boolean; cachedAt?: string }) => void;
  initialMode?: 'read' | 'edit';
}

/** 底部抽屉：代码大纲，或主动打开的符号操作单。 */
type Drawer =
  | { type: 'outline' }
  | {
      type: 'symbol';
      symbol: string;
      line: number;
      results: { kind: 'defs' | 'refs'; lines: number[] } | null;
      message: string | null;
    }
  | { type: 'diagnostics'; analyzer: string };

type EditState = 'clean' | 'dirty' | 'saving' | 'synced' | 'conflict';

const AUTOSAVE_DEBOUNCE_MS = 800;
const AUTOSAVE_NAME = '自动草稿';

const EDIT_STATE_TEXT: Record<EditState, string> = {
  clean: '无未保存修改',
  dirty: '有未保存到电脑的修改',
  saving: '正在保存到电脑…',
  synced: '✔ 已同步到电脑',
  conflict: '电脑文件已在别处修改，请选择处理方式',
};

/** 全屏编辑顶栏用的短状态（空间有限）。 */
const IMMERSIVE_STATE_TEXT: Record<EditState, string> = {
  clean: '已存本机',
  dirty: '待同步',
  saving: '保存中',
  synced: '已同步',
  conflict: '冲突',
};

/**
 * 文件页（S4a）：CodeMirror 6 阅读/编辑（语法高亮、行号、折行开关），
 * 阅读位置跨重启持久化；草稿自动保存、可命名、可重命名、可多份。
 *
 * 草稿并发规则（S3b 真机反馈修订）：
 * - 所有草稿存储操作经**单一串行队列**执行，杜绝读-改-写互相覆盖；
 * - 切换/新建草稿前先取消自动保存定时器，并把当前编辑内容先落盘到
 *   “离开”的草稿，再原子切换活动草稿——名字与内容永远对应；
 * - 活动草稿 id/内容/状态 同时维护 state 与 ref，异步回调读 ref 不读旧闭包。
 */
export function FileScreen({
  client,
  projectId,
  initialData,
  fromCache,
  cachedAt,
  online,
  revoked,
  onBack,
  registerBackGuard,
  onImmersiveChange,
  initialLine,
  projectName,
  onOpenRelated,
  initialMode = 'read',
}: Props) {
  const [data, setData] = useState<FileContentResponse>(initialData);
  const [cacheSource, setCacheSource] = useState(!!fromCache);
  const [mode, setMode] = useState<'read' | 'edit'>(initialMode);
  const [editText, setEditText] = useState(initialData.content);
  const [editState, setEditState] = useState<EditState>('clean');
  const [drafts, setDraftsState] = useState<FileDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [localDraftState, setLocalDraftState] = useState<'pending' | 'saved' | 'error'>('saved');
  const { prefs, update: updateAppearance } = useAppearance();
  const wrap = prefs.wrap;
  /** 上次关闭 App 时的阅读位置（打开文件后异步读出）。 */
  const [savedReadTop, setSavedReadTop] = useState<number | null>(null);
  /** 全屏模式：阅读/编辑共用，文件页默认全屏（S4a2 修订：编辑不再退出全屏）。 */
  const [immersive, setImmersive] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchOffset = useRef(0);
  /** 全屏编辑的「⋯」扩展行（＋草稿/重命名/删除/折行）。 */
  const [moreVisible, setMoreVisible] = useState(false);
  /** 底部抽屉（大纲/符号操作）；跳转请求与「返回原位置」。 */
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ line: number; nonce: number } | null>(
    initialLine ? { line: initialLine, nonce: 0 } : null,
  );
  const jumpNonceRef = useRef(0);
  /** 跳转前所在位置：非 null 时显示「↩ 返回原位置」。 */
  const [returnTop, setReturnTop] = useState<number | null>(null);
  const jumpHistory = useRef<number[]>([]);
  /** 应用返回：写入 initialScrollTop 通道。 */
  const [returnScrollTop, setReturnScrollTop] = useState<number | null>(null);
  /** Python 诊断（S4d）：null=未检查；检查后波浪线 + 抽屉列表。 */
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const visibleContentRef = useRef(initialData.content);
  visibleContentRef.current = mode === 'edit' ? editText : data.content;
  useEffect(() => { setDiagnostics(null); }, [mode, data.content]);
  const [checking, setChecking] = useState(false);
  /** 片段分享（S4f）：只读模式的非空选区。 */
  const [snippet, setSnippet] = useState<
    { text: string; startLine: number; endLine: number } | null
  >(null);
  const [sharing, setSharing] = useState(false);
  const [contextQuery, setContextQuery] = useState<ContextQuery | null>(null);
  const cursorSymbolRef = useRef<{ symbol: string; line: number } | null>(null);
  const [cursorSymbol, setCursorSymbol] = useState<{ symbol: string; line: number } | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const [readingTools, setReadingTools] = useState<{ line: number; endLine: number } | null>(null);
  useEffect(() => { setSnippet(null); setCursorSymbol(null); cursorSymbolRef.current = null; }, [mode]);

  // 全屏状态同步给根布局（隐藏状态栏与页边距）；卸载时必还原
  useEffect(() => {
    onImmersiveChange?.(immersive);
    return () => onImmersiveChange?.(false);
  }, [immersive, onImmersiveChange]);

  const baseVersionRef = useRef<string>(initialData.version);
  const editTextRef = useRef(editText);
  editTextRef.current = editText;
  const editStateRef = useRef<EditState>(editState);
  editStateRef.current = editState;
  const activeDraftIdRef = useRef<string | null>(null);
  const draftsRef = useRef<FileDraft[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedModeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const editRevisionRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [conflictPreview, setConflictPreview] = useState<FileContentResponse | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  // ---- 阅读位置（S4a）：滚动容器在 CodeMirror 内部，位置落原生磁盘 KV ----
  const positionSaverRef = useRef(createPositionSaver(projectId, initialData.path));
  const lastReadTopRef = useRef<number | null>(null);
  const userScrolledRef = useRef(false);

  useEffect(() => {
    void (async () => {
      const [saved] = await Promise.all([
        loadReadPosition(projectId, initialData.path),
      ]);
      setSavedReadTop(saved?.scrollTop ?? null);
    })();
    return () => {
      void positionSaverRef.current.flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, initialData.path]);

  const onReadScroll = useCallback(
    (top: number) => {
      lastReadTopRef.current = top;
      userScrolledRef.current = true;
      setReturnScrollTop(null);
      positionSaverRef.current.push(top);
    },
    [],
  );

  /** 串行队列：所有草稿存储操作按提交顺序执行，避免读-改-写竞争。 */
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(operation, operation);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const applyStored = useCallback((stored: StoredDrafts) => {
    draftsRef.current = stored.drafts;
    setDraftsState(stored.drafts);
    activeDraftIdRef.current = stored.activeId;
    setActiveDraftId(stored.activeId);
  }, []);

  const cancelPendingAutosave = useCallback(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  }, []);

  const cancelSavedModeTimer = useCallback(() => {
    if (savedModeTimer.current) {
      clearTimeout(savedModeTimer.current);
      savedModeTimer.current = null;
    }
  }, []);

  // ---- 挂载时恢复草稿（重启/离线后继续编辑） ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await enqueue(() => loadDrafts(projectId, initialData.path));
      if (cancelled) return;
      applyStored(stored);
      const active =
        stored.drafts.find((draft) => draft.id === stored.activeId) ??
        stored.drafts[0] ??
        null;
      if (active) {
        setEditText(active.content);
        baseVersionRef.current = active.baseVersion;
        setEditState(active.content !== initialData.content ? 'dirty' : 'clean');
      }
    })().catch((cause) => {
      if (!cancelled) {
        setLocalDraftState('error');
        setMessage(cause instanceof Error ? cause.message : '本地草稿读取失败，已阻止覆盖写入');
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, initialData.path]);

  /** 把当前编辑内容落盘到“活动草稿”；没有活动草稿时创建「自动草稿」。 */
  const flushActiveDraft = useCallback(
    (contentOverride?: string): Promise<StoredDrafts | null> => {
      const text = contentOverride ?? editTextRef.current;
      const outgoingId = activeDraftIdRef.current;
      const existing = outgoingId
        ? draftsRef.current.find((draft) => draft.id === outgoingId)
        : null;
      const draft: FileDraft = {
        id: existing?.id ?? outgoingId ?? newDraftId(),
        name: existing?.name ?? AUTOSAVE_NAME,
        path: initialData.path,
        projectId,
        content: text,
        baseVersion: baseVersionRef.current,
        savedAt: new Date().toISOString(),
        encoding: data.encoding,
        newline: data.newline,
        projectName,
      };
      // 连续失焦/自动保存都应更新同一份草稿，不能在落盘等待期间生成新 id。
      if (!outgoingId) {
        activeDraftIdRef.current = draft.id;
        setActiveDraftId(draft.id);
      }
      return enqueue(() => upsertDraft(projectId, initialData.path, draft)).then(
        (stored) => {
          applyStored(stored);
          if (text === editTextRef.current) setLocalDraftState('saved');
          return stored;
        },
      ).catch(() => {
        setLocalDraftState('error');
        setMessage('本地草稿保存失败，内容仍在编辑器中，请勿关闭页面；可重试或复制备份。');
        return null;
      });
    },
    [applyStored, enqueue, initialData.path, projectId, data.encoding, data.newline, projectName],
  );

  const onEditChange = (value: string) => {
    if (value === editTextRef.current) return;
    editRevisionRef.current++;
    editTextRef.current = value;
    setEditText(value);
    setLocalDraftState('pending');
    cancelSavedModeTimer();
    setEditState((state) => (state === 'synced' || state === 'clean' ? 'dirty' : state));
    cancelPendingAutosave();
    autosaveTimer.current = setTimeout(() => void flushActiveDraft(value), AUTOSAVE_DEBOUNCE_MS);
  };

  const unmountFlushRef = useRef(flushActiveDraft);
  unmountFlushRef.current = flushActiveDraft;
  useEffect(() => () => {
    cancelPendingAutosave();
    cancelSavedModeTimer();
    if (editStateRef.current === 'dirty' || editStateRef.current === 'conflict') {
      void unmountFlushRef.current();
    }
  }, [cancelPendingAutosave, cancelSavedModeTimer]);

  // ---- 保存到电脑 ----
  const saveToPc = useCallback(
    async (overrideBaseVersion?: string) => {
      if (!client || savingRef.current || revoked || switchBusy) return;
      savingRef.current = true;
      const submittedContent = editTextRef.current;
      const submittedId = activeDraftIdRef.current ?? newDraftId();
      const submittedDraft = draftsRef.current.find((draft) => draft.id === submittedId);
      activeDraftIdRef.current = submittedId;
      setActiveDraftId(submittedId);
      cancelPendingAutosave();
      cancelSavedModeTimer();
      setSaving(true);
      setEditState('saving');
      setMessage(null);
      try {
        // 请求中断/页面卸载前，至少先把本次发送的正文保留到本机。
        if (!await flushActiveDraft(submittedContent)) { setEditState('dirty'); return; }
        const response = await client.saveFile(projectId, {
          path: initialData.path,
          base_version: overrideBaseVersion ?? baseVersionRef.current,
          content: submittedContent,
          encoding: data.encoding,
          newline: data.newline,
        });
        const updated: FileContentResponse = {
          ...data,
          content: submittedContent,
          version: response.version,
          size: response.size,
          mtime: response.mtime,
        };
        setData(updated);
        setCacheSource(false);
        void saveCachedFile(projectId, updated).catch(() => {
          setMessage('电脑保存成功，但本地缓存更新失败。');
        });
        // S4a2：保存成功**不再清空草稿**——草稿是修改版本/灵感的记录，
        // 由用户在草稿箱手动管理。这里把活动草稿更新为刚保存的内容与
        // 新版本号（继续从它编辑不会假冲突），其余草稿原样保留。
        baseVersionRef.current = response.version;
        // 队列真正执行时取最新编辑文本；缓存只存已发送的正文，草稿保留后续输入。
        let persistedContent = submittedContent;
        const stored = await enqueue(() => {
          persistedContent = editTextRef.current;
          return upsertDraft(projectId, initialData.path, {
            id: submittedId,
            name: submittedDraft?.name ?? AUTOSAVE_NAME,
            path: initialData.path,
            projectId,
            content: persistedContent,
            baseVersion: response.version,
            savedAt: new Date().toISOString(),
            encoding: data.encoding,
            newline: data.newline,
            projectName,
          });
        });
        applyStored(stored);
        setLocalDraftState(persistedContent === editTextRef.current ? 'saved' : 'pending');
        setDiagnostics(null);
        setConflictVersion(null);
        if (editTextRef.current === submittedContent) {
          setEditState('synced');
          const confirmedRevision = editRevisionRef.current;
          savedModeTimer.current = setTimeout(() => {
            if (editRevisionRef.current !== confirmedRevision || savingRef.current) return;
            setMode('read');
            setEditState('clean');
          }, 900);
        } else {
          setEditState('dirty');
        }
      } catch (error) {
        if (error instanceof PocketCodeError && error.code === 'VERSION_CONFLICT') {
          setConflictPreview(null);
          setConflictVersion(
            (error.details?.current_version as string | undefined) ?? null,
          );
          setEditState('conflict');
          await flushActiveDraft();
        } else if (error instanceof PocketCodeError && error.code === 'OFFLINE') {
          const retained = await flushActiveDraft();
          setEditState('dirty');
          if (retained) setMessage('当前离线，无法保存到电脑；草稿已保留，联网后再保存。');
        } else {
          const retained = await flushActiveDraft();
          setEditState('dirty');
          if (retained) setMessage(error instanceof PocketCodeError ? error.message : '电脑操作或本地草稿保存失败，请确认内容后重试');
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [
      applyStored,
      cancelPendingAutosave,
      cancelSavedModeTimer,
      client,
      data,
      enqueue,
      flushActiveDraft,
      initialData.path,
      projectId,
      projectName,
      revoked,
      switchBusy,
    ],
  );

  const confirmOverwrite = () => {
    if (!conflictVersion) return;
    const confirmed = window.confirm(
      '将用手机上的内容覆盖电脑上的最新版本。\n' +
        '覆盖前电脑端会尝试创建快照；建议先查看差异。\n确认覆盖？',
    );
    if (confirmed) void saveToPc(conflictVersion);
  };

  /** 阅读数据与草稿编辑缓冲区分开；刷新不改变活动草稿正文或来源版本。 */
  const reloadFromPc = async (): Promise<boolean> => {
    if (!client || revoked) {
      setMessage('无法从电脑加载最新版本');
      return false;
    }
    setSaving(true);
    try {
      const fresh = await client.readFile(projectId, initialData.path);
      setData(fresh);
      setCacheSource(false);
      void saveCachedFile(projectId, fresh);
      if (!activeDraftIdRef.current) {
        setEditText(fresh.content);
        editTextRef.current = fresh.content;
        baseVersionRef.current = fresh.version;
        setEditState('clean');
      }
      setConflictVersion(null);
      return true;
    } catch (cause) {
      setMessage(cause instanceof PocketCodeError ? cause.message : '加载失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** 冲突框「放弃修改，加载电脑版」：丢弃的是**当前活动草稿**（其余命名
   *  草稿保留在草稿箱，可随时删除），然后加载电脑最新内容。 */
  const discardAndReload = async () => {
    if (!client || revoked || savingRef.current) {
      setMessage('无法从电脑加载最新版本');
      return;
    }
    if (!window.confirm('删除当前活动草稿并加载电脑版？其他草稿会保留。此操作会放弃当前修改。')) return;
    cancelPendingAutosave();
    setSwitchBusy(true);
    try {
      // 先取得电脑版；网络失败时不得先删除唯一的本地修改。
      const fresh = await client.readFile(projectId, initialData.path);
      const activeId = activeDraftIdRef.current;
      const stored = activeId
        ? await enqueue(() => removeDraft(projectId, initialData.path, activeId))
        : { activeId: null, drafts: [] };
      applyStored(stored);
      const next = stored.drafts.find((draft) => draft.id === stored.activeId);
      setData(fresh);
      setCacheSource(false);
      void saveCachedFile(projectId, fresh).catch(() => undefined);
      setEditText(next?.content ?? fresh.content);
      editTextRef.current = next?.content ?? fresh.content;
      baseVersionRef.current = next?.baseVersion ?? fresh.version;
      setEditState(next && next.content !== fresh.content ? 'dirty' : 'clean');
      setConflictVersion(null);
      setDiagnostics(null);
      setMode('read');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载失败，草稿仍保留');
    } finally {
      setSwitchBusy(false);
    }
  };

  // ---- 草稿切换 / 新建 / 删除 ----
  const switchDraft = async (id: string) => {
    if (id === activeDraftIdRef.current || switchBusy || savingRef.current) return;
    cancelPendingAutosave();
    const target = draftsRef.current.find((draft) => draft.id === id);
    if (!target) return;
    setSwitchBusy(true);
    try {
      // 1) 先把当前编辑内容落盘到“离开”的草稿
      if (
        activeDraftIdRef.current &&
        (editStateRef.current === 'dirty' || editStateRef.current === 'conflict')
      ) {
        if (!(await flushActiveDraft())) return;
      }
      // 2) 再原子切换活动草标
      const stored = await enqueue(() => setActiveDraft(projectId, initialData.path, id));
      applyStored(stored);
      const freshTarget =
        stored.drafts.find((draft) => draft.id === id) ?? target;
      setEditText(freshTarget.content);
      baseVersionRef.current = freshTarget.baseVersion;
      setEditState(freshTarget.content !== data.content ? 'dirty' : 'clean');
      setConflictVersion(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '草稿切换失败');
    } finally {
      setSwitchBusy(false);
    }
  };

  const createDraft = async () => {
    if (switchBusy || savingRef.current) return;
    const name = window.prompt('草稿名称（如：异常处理实验 A）', `草稿 ${drafts.length + 1}`);
    if (name === null) return;
    cancelPendingAutosave();
    setSwitchBusy(true);
    try {
      // 当前内容先落盘到“离开”的草稿，再以其内容派生新草稿
      if (
        activeDraftIdRef.current &&
        (editStateRef.current === 'dirty' || editStateRef.current === 'conflict')
      ) {
        if (!(await flushActiveDraft())) return;
      }
      const draft: FileDraft = {
        id: newDraftId(),
        name: name.trim() || `草稿 ${draftsRef.current.length + 1}`,
        path: initialData.path,
        projectId,
        content: editTextRef.current,
        baseVersion: baseVersionRef.current,
        savedAt: new Date().toISOString(),
        encoding: data.encoding,
        newline: data.newline,
        projectName,
      };
      const stored = await enqueue(() => upsertDraft(projectId, initialData.path, draft));
      applyStored(stored);
      setEditState((state) => (state === 'clean' ? 'clean' : state));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '新建草稿失败');
    } finally {
      setSwitchBusy(false);
    }
  };

  const deleteActiveDraft = async () => {
    const id = activeDraftIdRef.current;
    if (!id || switchBusy || savingRef.current) return;
    if (!window.confirm('删除当前草稿？其未保存的修改将丢失。')) return;
    cancelPendingAutosave();
    setSwitchBusy(true);
    try {
      const stored = await enqueue(() => removeDraft(projectId, initialData.path, id));
      applyStored(stored);
      const next = stored.drafts.find((draft) => draft.id === stored.activeId);
      if (next) {
        setEditText(next.content);
        baseVersionRef.current = next.baseVersion;
        setEditState(next.content !== data.content ? 'dirty' : 'clean');
      } else {
        setEditText(data.content);
        baseVersionRef.current = data.version;
        setEditState('clean');
      }
      setConflictVersion(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '删除草稿失败');
    } finally {
      setSwitchBusy(false);
    }
  };

  const renameActiveDraft = async () => {
    const id = activeDraftIdRef.current;
    const current = draftsRef.current.find((draft) => draft.id === id);
    if (!id || !current || switchBusy || savingRef.current) return;
    const name = window.prompt('重命名草稿', current.name);
    if (name === null) return;
    setSwitchBusy(true);
    try {
      const stored = await enqueue(() =>
        renameDraft(projectId, initialData.path, id, name),
      );
      if (stored) applyStored(stored);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '重命名失败');
    } finally {
      setSwitchBusy(false);
    }
  };

  const exitEditToRead = useCallback(async () => {
    if (savingRef.current) return;
    cancelPendingAutosave();
    cancelSavedModeTimer();
    if (editStateRef.current === 'dirty' || editStateRef.current === 'conflict') {
      if (!(await flushActiveDraft())) return;
    }
    setMode('read');
  }, [cancelPendingAutosave, cancelSavedModeTimer, flushActiveDraft]);

  // ---- Android 返回键：编辑态先退出编辑（草稿保留），阅读态交给上级 ----
  useEffect(() => {
    registerBackGuard(() => {
      if (contextQuery) {
        setContextQuery(null);
        return true;
      }
      if (drawer) {
        setDrawer(null);
        return true;
      }
      if (moreVisible) { setMoreVisible(false); return true; }
      if (searchVisible) { setSearchVisible(false); return true; }
      if (focusMode) { setFocusMode(false); return true; }
      if (mode === 'edit') {
        void exitEditToRead();
        return true;
      }
      return false;
    });
    return () => registerBackGuard(null);
  }, [mode, exitEditToRead, registerBackGuard, contextQuery, drawer, moreVisible, searchVisible, focusMode]);

  const lineCount = (mode === 'edit' ? editText : data.content).split('\n').length;
  const readOnlyBlocked =
    data.read_only || data.encoding === 'utf-16-le' || data.encoding === 'utf-16-be';
  const isPythonFile = data.path.toLowerCase().endsWith('.py');
  // 草稿保留策略（S4a2）后，只有内容与电脑不一致的草稿才算"未保存"
  const hasUnsavedDraft = drafts.some((draft) => draft.content !== data.content);

  // 切换到编辑模式前把阅读位置落盘（阅读视图即将卸载）
  useEffect(() => {
    if (mode === 'edit') void positionSaverRef.current.flush();
  }, [mode]);

  // 阅读/编辑共用：CodeEditor 挂载时的初始滚动位置。
  // 「返回原位置」优先；否则用户本次已滚动过用最新位置，否则用磁盘恢复值。
  const initialReadTop = returnScrollTop !== null
    ? returnScrollTop
    : initialLine && !userScrolledRef.current
      ? null
    : userScrolledRef.current
      ? lastReadTopRef.current
      : savedReadTop;

  const contentLines = useMemo(
    () => (mode === 'edit' ? editText : data.content).split('\n'),
    [data.content, editText, mode],
  );
  const outlineSymbols = useMemo(
    () => extractOutline(mode === 'edit' ? editText : data.content, data.path),
    [data.content, data.path, editText, mode],
  );

  /** 跳到指定行（大纲/符号/诊断共用）：记录原位置以便返回。 */
  const jumpToLine = useCallback((line: number) => {
    const origin = lastReadTopRef.current ?? savedReadTop ?? 0;
    jumpHistory.current = [...jumpHistory.current, origin].slice(-20);
    setReturnTop(origin);
    setDrawer(null);
    setScrollRequest({ line, nonce: ++jumpNonceRef.current });
  }, [savedReadTop]);

  const goBackToOrigin = useCallback(() => {
    if (returnTop === null) return;
    setReturnScrollTop(jumpHistory.current.pop() ?? returnTop);
    setReturnTop(jumpHistory.current.at(-1) ?? null);
    setScrollRequest(null);
  }, [returnTop]);

  const openSymbolDrawer = useCallback((symbol: string, line: number) => {
    setDrawer({ type: 'symbol', symbol, line, results: null, message: null });
  }, []);

  // ---- 分享（S4f「给哥哥看」）：来源如实标注（PRD §8.1） ----
  const currentSource: ShareSource = cacheSource ? 'cache' : 'pc';

  const shareSnippet = useCallback(
    async (selection: { text: string; startLine: number; endLine: number }) => {
      setSharing(true);
      try {
        const outcome = await shareText(
          `代码片段 · ${initialData.path}`,
          buildSnippetText({
            path: initialData.path,
            startLine: selection.startLine,
            endLine: selection.endLine,
            code: selection.text,
            source: currentSource,
            projectName: initialData.project_id,
          }),
        );
        if (outcome.ok) {
          setSnippet(null);
          setMessage(outcome.copied ? '分享面板不可用，已复制片段到剪贴板' : null);
        } else {
          setMessage(outcome.message ?? '分享失败');
        }
      } finally {
        setSharing(false);
      }
    },
    [currentSource, initialData.path, initialData.project_id],
  );

  const shareWholeFile = useCallback(
    async (content: string, source: ShareSource) => {
      setSharing(true);
      try {
        const text = buildMultiFileText({
          projectName: initialData.project_id,
          files: [{ path: initialData.path, content }],
          source,
          fetchedAt: source === 'draft' ? null : (cachedAt ?? data.mtime),
        });
        const outcome = await shareText(
          `文件分享 · ${initialData.path}`,
          text,
        );
        if (outcome.ok && !outcome.copied) setMessage(null);
        else if (outcome.ok) setMessage('分享面板不可用，已复制全文到剪贴板');
        else setMessage(outcome.message ?? '分享失败');
      } finally {
        setSharing(false);
      }
    },
    [cachedAt, data.mtime, initialData.path, initialData.project_id],
  );

  // 进入编辑/文档变化时清掉过期的选区
  useEffect(() => {
    if (mode !== 'read') setSnippet(null);
  }, [mode]);

  // ---- Python 诊断（S4d，PRD §7：用户主动查看；未保存草稿直接检查）----
  const runDiagnostics = useCallback(async () => {
    if (!client || !online || revoked || checking) return;
    setChecking(true);
    setMessage(null);
    try {
      const checkedContent = mode === 'edit' ? editTextRef.current : data.content;
      const response = await client.diagnose(projectId, {
        path: initialData.path,
        content: checkedContent,
      });
      if (visibleContentRef.current !== checkedContent) { setMessage('正文已变化，请重新检查。'); return; }
      setDiagnostics(response.diagnostics);
      if (response.diagnostics.length === 0) {
        setDrawer(null);
        setMessage(`✔ 检查完成：没有发现问题（${response.analyzer}）`);
      } else {
        setDrawer({ type: 'diagnostics', analyzer: response.analyzer });
      }
    } catch (cause) {
      setMessage(cause instanceof PocketCodeError ? cause.message : '检查失败');
    } finally {
      setChecking(false);
    }
  }, [checking, client, data.content, initialData.path, mode, online, projectId, revoked]);

  const patchSymbolDrawer = useCallback(
    (patch: { results?: { kind: 'defs' | 'refs'; lines: number[] } | null; message?: string | null }) => {
      setDrawer((current) =>
        current && current.type === 'symbol' ? { ...current, ...patch } : current,
      );
    },
    [],
  );

  const openContext = useCallback((view: ContextView = 'related', symbol?: string, line?: number) => {
    if (!isPythonFile || !client || !online || revoked) {
      setMessage('Python 跨文件关联需要连接电脑；离线仍可使用本文件的大纲与查找。');
      return;
    }
    setDrawer(null);
    setContextQuery({ view, request: {
      path: data.path, symbol, line,
      ...(mode === 'edit' ? { content: editTextRef.current, source: 'draft' as const }
        : cacheSource ? { content: data.content, source: 'cache' as const } : {}),
    } });
  }, [isPythonFile, client, online, revoked, data, mode, cacheSource]);

  const navigateContext = async (location: PythonLocation | PythonRelatedFile) => {
    if (!client || !online || revoked) throw new Error('电脑不可用，暂时无法跳转。');
    if (location.path === data.path && contextQuery?.request.content !== undefined) {
      const visibleText = mode === 'edit' ? editTextRef.current : data.content;
      if (visibleText !== contextQuery.request.content) throw new Error('当前正文已变化，请重新分析后定位。');
      jumpToLine(location.line);
      setContextQuery(null);
      return;
    }
    const fresh = await client.readFile(projectId, location.path);
    if (fresh.version !== location.version) throw new Error('目标文件在分析后已变化，请重新分析后定位。');
    void saveCachedFile(projectId, fresh).catch(() => undefined);
    if (location.path === data.path) {
      setData(fresh);
      setCacheSource(false);
      if (!activeDraftIdRef.current) {
        setEditText(fresh.content);
        baseVersionRef.current = fresh.version;
      }
      jumpToLine(location.line);
      setContextQuery(null);
    } else {
      if (!onOpenRelated) throw new Error('当前页面无法打开跨文件导航。');
      cancelPendingAutosave();
      if (editStateRef.current === 'dirty' || editStateRef.current === 'conflict') {
        if (!(await flushActiveDraft())) throw new Error('请先处理本地草稿保存失败，再跳转文件。');
      }
      await positionSaverRef.current.flush();
      onOpenRelated(fresh, location.line, { data, mode, ...(fromCache ? { fromCache: cacheSource, cachedAt } : {}) });
    }
  };

  const jumpToDefinitions = useCallback(
    (symbol: string) => {
      if (isPythonFile && online && !revoked && client) {
        openContext('definitions', symbol, drawer?.type === 'symbol' ? drawer.line : undefined);
        return;
      }
      const defs = findDefinitions(data.content, data.path, symbol);
      if (defs.length === 0) {
        patchSymbolDrawer({
          message: `本文件内没有「${symbol}」的定义（跨文件跳转属后续阶段）`,
        });
        return;
      }
      if (defs.length === 1) {
        jumpToLine(defs[0]);
        return;
      }
      patchSymbolDrawer({ results: { kind: 'defs', lines: defs }, message: null });
    },
    [data.content, data.path, jumpToLine, patchSymbolDrawer, isPythonFile, online, revoked, client, openContext, drawer],
  );

  const showReferences = useCallback(
    (symbol: string) => {
      if (isPythonFile && online && !revoked && client) {
        openContext('references', symbol, drawer?.type === 'symbol' ? drawer.line : undefined);
        return;
      }
      const refs = findReferences(data.content, symbol);
      if (refs.length === 0) {
        patchSymbolDrawer({ message: `本文件内没有「${symbol}」的其他出现` });
        return;
      }
      patchSymbolDrawer({ results: { kind: 'refs', lines: refs }, message: null });
    },
    [data.content, patchSymbolDrawer, isPythonFile, online, revoked, client, openContext, drawer],
  );

  const copySymbol = useCallback(async (symbol: string) => {
    try {
      await navigator.clipboard.writeText(symbol);
      setDrawer(null);
    } catch {
      patchSymbolDrawer({ message: '复制失败：当前环境不允许访问剪贴板' });
    }
  }, [patchSymbolDrawer]);

  // ---- 底部抽屉与返回原位置（阅读模式共用）----
  const symbolIcon = (symbol: OutlineSymbol) =>
    symbol.kind === 'class' ? '◆' : symbol.kind === 'method' ? '‣' : symbol.kind === 'heading' ? '§' : 'ƒ';

  const contextJsx = contextQuery && client ? <PythonContextPanel
    client={client} projectId={projectId} projectName={projectName ?? projectId} query={contextQuery}
    online={online} revoked={revoked} onClose={() => setContextQuery(null)} onNavigate={navigateContext}
  /> : null;

  const drawerJsx = drawer ? (
    <ActionSheet title="代码导航" onClose={() => setDrawer(null)}>
        {drawer.type === 'outline' ? (
          <>
            <p className="sheet__title">代码大纲（{outlineSymbols.length}）</p>
            {outlineSymbols.length === 0 ? (
              <p className="sheet__empty">
                该文件类型暂不支持大纲（支持 Python / JS / TS / Java / Markdown）。
              </p>
            ) : (
              <ul className="sheet__list">
                {outlineSymbols.map((symbol) => (
                  <li key={`${symbol.line}:${symbol.name}`}>
                    <button
                      type="button"
                      className="sheet__item"
                      style={{ paddingLeft: `${12 + symbol.indent * 16}px` }}
                      onClick={() => jumpToLine(symbol.line)}
                    >
                      <span className={`sheet__kind sheet__kind--${symbol.kind}`}>
                        {symbolIcon(symbol)}
                      </span>
                      <span className="sheet__name">{symbol.name}</span>
                      <span className="sheet__lineno">:{symbol.line}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : drawer.type === 'diagnostics' ? (
          <>
            <p className="sheet__title">
              诊断（{diagnostics?.length ?? 0}）· {drawer.analyzer}
            </p>
            <p className="sheet__empty">点条目定位到对应行；重新编辑后可再次检查。</p>
            <ul className="sheet__list">
              {(diagnostics ?? []).map((diagnostic, index) => (
                <li key={`${diagnostic.line}:${diagnostic.column}:${index}`}>
                  <button
                    type="button"
                    className="sheet__item"
                    onClick={() => jumpToLine(diagnostic.line)}
                  >
                    <span
                      className={`sheet__kind ${
                        diagnostic.severity === 'error'
                          ? 'diag-icon-error'
                          : 'diag-icon-warning'
                      }`}
                    >
                      {diagnostic.severity === 'error' ? '✘' : '⚠'}
                    </span>
                    <span className="sheet__name">{diagnostic.message}</span>
                    <span className="sheet__lineno">
                      {diagnostic.code} :{diagnostic.line}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="sheet__title">「{drawer.symbol}」· 第 {drawer.line} 行</p>
            <div className="btnrow">
              <button
                type="button"
                className="btn"
                onClick={() => jumpToDefinitions(drawer.symbol)}
              >
                跳转定义
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => showReferences(drawer.symbol)}
              >
                查找引用
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void copySymbol(drawer.symbol)}
              >
                复制符号
              </button>
              {isPythonFile ? <button type="button" className="btn" disabled={!online || revoked}
                onClick={() => openContext('related', drawer.symbol, drawer.line)}>关联分享</button> : null}
            </div>
            {drawer.message ? <p className="hint hint--error">{drawer.message}</p> : null}
            {drawer.results ? (
              <>
                <p className="hint">
                  {drawer.results.kind === 'defs' ? '多个定义，选择一处：' : '本文件内的出现：'}
                </p>
                <ul className="sheet__list">
                  {drawer.results.lines.map((lineNo) => (
                    <li key={lineNo}>
                      <button
                        type="button"
                        className="sheet__item"
                        onClick={() => jumpToLine(lineNo)}
                      >
                        <span className="sheet__lineno">:{lineNo}</span>
                        <span className="sheet__name sheet__name--code">
                          {(contentLines[lineNo - 1] ?? '').trim()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
    </ActionSheet>
  ) : null;

  const returnPill =
    mode === 'read' && returnTop !== null ? (
      <button type="button" className="return-pill" onClick={goBackToOrigin}>
        ↩ 返回原位置
      </button>
    ) : null;

  // 片段分享浮标：只读模式有非空选区时出现（抬高避免和返回浮标重叠）
  const snippetPill =
    mode === 'read' && snippet !== null ? (
      <div className="return-pill return-pill--raised selection-actions" role="toolbar" aria-label="选中代码操作">
        <button type="button" onClick={() => { void copyText(snippet.text).then((result) => setMessage(result.ok ? '已复制选中代码' : result.message ?? '复制失败')); }}>复制</button>
        <button type="button" onClick={() => void shareSnippet(snippet)} disabled={sharing}>分享选中</button>
        <button type="button" onClick={() => setReadingTools({ line: snippet.startLine, endLine: snippet.endLine })}>写旁注</button>
      </div>
    ) : null;

  const toggleImmersiveWrap = () => {
    updateAppearance({ wrap: !wrap });
  };

  const saveAs = async () => {
    if (!client || !online || revoked || savingRef.current || switchBusy) return;
    const proposed = data.path.replace(/(\.[^/.]+)?$/, '-手机版本$1');
    const path = window.prompt('另存为项目内新文件（不会覆盖已有文件）', proposed)?.trim();
    if (!path) return;
    const content = editTextRef.current;
    savingRef.current = true; setSaving(true);
    try {
      cancelPendingAutosave();
      if (!await flushActiveDraft(content)) return;
      await client.createEntry(projectId, { path, type: 'file', content, encoding: data.encoding, newline: data.newline });
      setMessage(`已另存为 ${path}。原文件和当前草稿保留，可在目录中打开新文件。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '另存为失败，草稿保留'); }
    finally { savingRef.current = false; setSaving(false); }
  };

  // 共享片段：草稿选择器与冲突处理块（普通布局与全屏编辑都用）
  const draftsSelect = (
    <select
      className="editbar__select"
      value={activeDraftId ?? ''}
      onChange={(event) => void switchDraft(event.target.value)}
      disabled={switchBusy || saving}
    >
      {drafts.length === 0 ? <option value="">{AUTOSAVE_NAME}</option> : null}
      {drafts.map((draft) => (
        <option key={draft.id} value={draft.id}>
          {draft.name}
        </option>
      ))}
    </select>
  );

  const conflictPanel =
    editState === 'conflict' ? (
      <div className="result result--bad">
        <p className="result__title">✘ 电脑上的文件已被其他程序修改</p>
        <p className="result__hint">
          你的草稿基于较早的版本。先查看差异，或保留草稿继续编辑。覆盖与放弃修改需要单独确认。
        </p>
        <div className="btnrow">
          <button type="button" className="btn btn--primary" disabled={!client || !online || revoked || diffBusy || saving || switchBusy} onClick={() => {
            if (!client) return;
            setDiffBusy(true);
            void (async () => {
              if (!await flushActiveDraft()) return;
              const fresh = await client.readFile(projectId, initialData.path);
              setConflictPreview(fresh);
              setConflictVersion(fresh.version);
            })().catch((cause) => setMessage(cause instanceof Error ? cause.message : '差异读取失败，草稿保留')).finally(() => setDiffBusy(false));
          }}>
            {diffBusy ? '正在读取差异…' : '查看差异'}
          </button>
          <button type="button" className="btn" disabled={saving || switchBusy || diffBusy} onClick={() => { void flushActiveDraft().then((stored) => { if (stored) { setEditState('dirty'); setConflictVersion(null); setMessage('草稿已保留，可以继续编辑或稍后处理。'); } }); }}>保留草稿，继续编辑</button>
          <button type="button" className="btn" disabled={!client || !online || revoked || saving || switchBusy || diffBusy} onClick={() => void saveAs()}>另存为新文件</button>
          <button type="button" className="btn" disabled={!online || revoked || !conflictVersion || saving || switchBusy || diffBusy} onClick={confirmOverwrite}>覆盖电脑文件</button>
          <button
            type="button"
            className="btn"
            onClick={() => void discardAndReload()}
            disabled={!online || revoked || saving || switchBusy || diffBusy}
          >
            放弃修改，加载电脑版
          </button>
        </div>
      </div>
    ) : null;

  const findNext = () => {
    const content = mode === 'edit' ? editTextRef.current : data.content;
    if (!searchQuery) return;
    const lower = content.toLowerCase();
    let index = lower.indexOf(searchQuery.toLowerCase(), searchOffset.current);
    if (index < 0) index = lower.indexOf(searchQuery.toLowerCase());
    if (index < 0) { setMessage('没有找到匹配内容'); return; }
    searchOffset.current = index + Math.max(1, searchQuery.length);
    jumpToLine(content.slice(0, index).split('\n').length);
  };
  const withMenuClosed = (action: () => void) => () => { setMoreVisible(false); action(); };
  return (
    <section className={`file-workspace ${immersive ? 'file-workspace--full' : ''}`}>
      {conflictPreview && <ConflictDiff computer={conflictPreview.content} draft={editText} onClose={() => setConflictPreview(null)} />}
      {!focusMode && <>
        <header className="code-toolbar">
          <button type="button" className="icon-button" aria-label={mode === 'edit' ? '完成编辑' : '返回文件浏览'} title={mode === 'edit' ? '完成编辑' : '返回文件浏览'} disabled={mode === 'edit' && (saving || switchBusy)} onClick={mode === 'edit' ? exitEditToRead : onBack}><Icon name={mode === 'edit' ? 'check' : 'back'} /></button>
          <div className="code-title"><strong>{data.path.split('/').pop()}</strong><small>{projectName} · {mode === 'edit' ? '手机草稿' : cacheSource ? '本地缓存 · 只读' : '电脑文件 · 只读'}{hasUnsavedDraft && mode === 'read' ? ' · 有草稿' : ''}</small></div>
          <button type="button" className="icon-button" aria-label="搜索代码" title="搜索代码" aria-pressed={searchVisible} onClick={() => setSearchVisible(!searchVisible)}><Icon name="search" /></button>
          {mode === 'read' ? <button type="button" className="icon-button" aria-label="编辑" title={readOnlyBlocked ? '只读文件' : '编辑'} disabled={readOnlyBlocked || revoked} onClick={() => setMode('edit')}><Icon name="edit" /></button>
            : <button type="button" className="icon-button" aria-label="保存" title="保存到电脑" onClick={() => void saveToPc()} disabled={saving || revoked || switchBusy || (editState !== 'dirty' && editState !== 'conflict')}><Icon name="save" /></button>}
          <button type="button" className="icon-button" aria-label="更多操作" title="更多操作" onClick={() => setMoreVisible(true)}><Icon name="more" /></button>
        </header>
        {searchVisible && <form className="code-search" onSubmit={(event) => { event.preventDefault(); findNext(); }}><input aria-label="搜索代码内容" placeholder="在文件中查找…" value={searchQuery} onChange={(event) => { searchOffset.current = 0; setSearchQuery(event.target.value); }} /><button type="submit">下一处</button><button type="button" aria-label="关闭搜索" onClick={() => setSearchVisible(false)}><Icon name="close" size={17} /></button></form>}
        {mode === 'edit' && <div className="draft-bar">{draftsSelect}<span title={EDIT_STATE_TEXT[editState]}>{localDraftState === 'error' ? '本地草稿保存失败' : localDraftState === 'pending' ? '草稿待保存' : editState === 'dirty' ? '本机已存 · 待同步' : IMMERSIVE_STATE_TEXT[editState]}{switchBusy ? '…' : ''}</span></div>}
      </>}
      {cacheSource && <p className="file-notice">本地缓存 · {cachedAt ? new Date(cachedAt).toLocaleString('zh-CN') : '时间未知'} · 联网刷新可获取电脑最新内容</p>}
      {revoked && <p className="file-notice file-notice--error">授权已撤销，无法刷新和保存到电脑。</p>}
      {mode === 'edit' && conflictPanel}
      <div className="code-document"><CodeEditor
        className="cmhost--workspace"
        doc={mode === 'edit' ? editText : data.content}
        readOnly={mode === 'read'} fileName={data.path} wrap={wrap}
        initialScrollTop={mode === 'read' ? initialReadTop : undefined}
        scrollRequest={scrollRequest} diagnostics={diagnostics ?? undefined}
        onDocChange={onEditChange}
        onSelection={mode === 'read' ? setSnippet : undefined}
        onScrollTop={mode === 'read' ? onReadScroll : undefined}
        onCursorSymbol={(value) => { cursorSymbolRef.current = value; setCursorSymbol(value); }}
        onCursorLine={setCursorLine}
        onBlur={() => { if (mode !== 'edit') return; cancelPendingAutosave(); if (editStateRef.current === 'dirty' || editStateRef.current === 'conflict') void flushActiveDraft(); }}
      /></div>
      {!focusMode && <footer className="code-footer"><button type="button" onClick={() => setDrawer({ type: 'outline' })}><Icon name="outline" size={16} />大纲</button><button type="button" disabled={!!snippet || !cursorSymbol || saving} title={cursorSymbol ? `导航 ${cursorSymbol.symbol}` : '先轻点函数或变量名'} onClick={() => { if (cursorSymbol) openSymbolDrawer(cursorSymbol.symbol, cursorSymbol.line); }}><Icon name="code" size={16} />代码导航</button>{mode === 'read' && <button type="button" onClick={() => setReadingTools({ line: snippet?.startLine ?? cursorLine, endLine: snippet?.endLine ?? cursorLine })}><Icon name="bookmark" size={16} />书签旁注</button>}{isPythonFile && !snippet && <button type="button" disabled={!online || revoked || saving} onClick={() => openContext()}><Icon name="link" size={16} />关联</button>}<span>{lineCount} 行</span></footer>}
      {focusMode && <button type="button" className="focus-exit" aria-label="退出专注阅读" title="退出专注阅读" onClick={() => setFocusMode(false)}><Icon name="expand" /></button>}
      {message && <p className="file-notice file-notice--error" role="status">{message}</p>}
      {!online && mode === 'edit' && <p className="file-notice">离线：可以继续编辑，草稿保留在本机。</p>}
      {returnPill}{snippetPill}{drawerJsx}{contextJsx}
      {readingTools && <ReadingTools projectId={projectId} path={data.path} content={data.content} version={data.version} line={readingTools.line} endLine={readingTools.endLine} onJump={jumpToLine} onClose={() => setReadingTools(null)} />}
      {moreVisible && <ActionSheet title={mode === 'read' ? '代码工具' : '草稿工具'} onClose={() => setMoreVisible(false)}>
        <MenuItem icon="outline" onClick={withMenuClosed(() => setDrawer({ type: 'outline' }))}>代码大纲</MenuItem>
        {isPythonFile && <MenuItem icon="link" disabled={!online || revoked || saving} onClick={withMenuClosed(() => openContext())}>{mode === 'edit' ? '关联草稿' : '智能关联'}</MenuItem>}
        {isPythonFile && mode === 'edit' && <MenuItem icon="code" disabled={!online || revoked || saving} onClick={withMenuClosed(() => { const cursor = cursorSymbolRef.current; if (cursor) openContext('definitions', cursor.symbol, cursor.line); else setMessage('请先将光标放在符号旁，再打开代码操作。'); })}>光标处定义与引用</MenuItem>}
        {isPythonFile && <MenuItem icon="shield" disabled={!online || revoked || checking || saving} onClick={withMenuClosed(() => { void runDiagnostics(); })}>{checking ? '检查中…' : '检查语法与诊断'}</MenuItem>}
        <MenuItem icon="share" disabled={sharing} onClick={withMenuClosed(() => { void shareWholeFile(mode === 'edit' ? editTextRef.current : data.content, mode === 'edit' ? 'draft' : currentSource); })}>{mode === 'edit' ? '分享草稿' : '分享文件'}</MenuItem>
        {mode === 'read' && <MenuItem icon="copy" disabled={!snippet} onClick={withMenuClosed(() => { if (snippet) void copyText(snippet.text).then((result) => setMessage(result.ok ? '已复制选中代码' : result.message ?? '复制失败')); })}>复制选中代码</MenuItem>}
        {mode === 'read' && <MenuItem icon="refresh" aria-label="刷新" disabled={!online || revoked || saving} onClick={withMenuClosed(() => { void reloadFromPc(); })}>刷新电脑版本</MenuItem>}
        <MenuItem icon="outline" onClick={toggleImmersiveWrap}>{wrap ? '自动折行：开' : '自动折行：关'}</MenuItem>
        <MenuItem icon="expand" onClick={withMenuClosed(() => { setImmersive(true); setFocusMode(true); })}>专注阅读</MenuItem>
        <MenuItem icon="system" onClick={withMenuClosed(() => setImmersive(!immersive))}>{immersive ? '显示连接状态栏' : '隐藏连接状态栏'}</MenuItem>
        {mode === 'edit' && <>
          <MenuItem icon="file" disabled={!online || revoked || saving || switchBusy} onClick={withMenuClosed(() => { void saveAs(); })}>另存为新文件</MenuItem>
          <MenuItem icon="plus" disabled={switchBusy || saving} onClick={withMenuClosed(() => { void createDraft(); })}>新建命名草稿</MenuItem>
          <MenuItem icon="edit" disabled={!activeDraftId || switchBusy || saving} onClick={withMenuClosed(() => { void renameActiveDraft(); })}>重命名草稿</MenuItem>
          <MenuItem icon="trash" danger disabled={!drafts.length || switchBusy || saving} onClick={withMenuClosed(() => { void deleteActiveDraft(); })}>删除当前草稿</MenuItem>
        </>}
      </ActionSheet>}
    </section>
  );
}
