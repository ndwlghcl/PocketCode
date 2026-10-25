import { useCallback, useEffect, useRef, useState } from 'react';

import type { FileContentResponse } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { saveCachedFile } from '../../storage/cacheStore';
import { restoreScrollValue, saveScrollValue } from '../../app/scrollMemory';
import {
  clearDrafts,
  loadDrafts,
  newDraftId,
  removeDraft,
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
}

type EditState = 'clean' | 'dirty' | 'saving' | 'synced' | 'conflict';

const AUTOSAVE_DEBOUNCE_MS = 800;
const AUTOSAVE_NAME = '自动草稿';

const EDIT_STATE_TEXT: Record<EditState, string> = {
  clean: '无未保存修改',
  dirty: '有未保存修改（已自动存为本地草稿）',
  saving: '正在保存到电脑…',
  synced: '✔ 已同步到电脑',
  conflict: '电脑文件已在别处修改，请选择处理方式',
};

/**
 * 文件页（S3b）：默认阅读，主动进入编辑；草稿自动保存、可命名、可多份。
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
}: Props) {
  const [data, setData] = useState<FileContentResponse>(initialData);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [editText, setEditText] = useState(initialData.content);
  const [editState, setEditState] = useState<EditState>('clean');
  const [drafts, setDraftsState] = useState<FileDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);

  const baseVersionRef = useRef<string>(initialData.version);
  const editTextRef = useRef(editText);
  editTextRef.current = editText;
  const editStateRef = useRef<EditState>(editState);
  editStateRef.current = editState;
  const activeDraftIdRef = useRef<string | null>(null);
  const draftsRef = useRef<FileDraft[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

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
    })();
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
        id: existing?.id ?? newDraftId(),
        name: existing?.name ?? AUTOSAVE_NAME,
        path: initialData.path,
        projectId,
        content: text,
        baseVersion: baseVersionRef.current,
        savedAt: new Date().toISOString(),
      };
      return enqueue(() => upsertDraft(projectId, initialData.path, draft)).then(
        (stored) => {
          applyStored(stored);
          return stored;
        },
      );
    },
    [applyStored, enqueue, initialData.path, projectId],
  );

  const onEditChange = (value: string) => {
    setEditText(value);
    setEditState((state) => (state === 'synced' || state === 'clean' ? 'dirty' : state));
    cancelPendingAutosave();
    autosaveTimer.current = setTimeout(() => void flushActiveDraft(value), AUTOSAVE_DEBOUNCE_MS);
  };

  // ---- 保存到电脑 ----
  const saveToPc = useCallback(
    async (overrideBaseVersion?: string) => {
      if (!client) return;
      cancelPendingAutosave();
      setSaving(true);
      setEditState('saving');
      setMessage(null);
      try {
        const response = await client.saveFile(projectId, {
          path: initialData.path,
          base_version: overrideBaseVersion ?? baseVersionRef.current,
          content: editTextRef.current,
          encoding: data.encoding,
          newline: data.newline,
        });
        const updated: FileContentResponse = {
          ...data,
          content: editTextRef.current,
          version: response.version,
          size: response.size,
          mtime: response.mtime,
        };
        setData(updated);
        void saveCachedFile(projectId, updated);
        await enqueue(() => clearDrafts(projectId, initialData.path));
        applyStored({ activeId: null, drafts: [] });
        baseVersionRef.current = response.version;
        setConflictVersion(null);
        setEditState('synced');
        setTimeout(() => {
          setMode('read');
          setEditState('clean');
          setEditText(updated.content);
        }, 900);
      } catch (error) {
        if (error instanceof PocketCodeError && error.code === 'VERSION_CONFLICT') {
          setConflictVersion(
            (error.details?.current_version as string | undefined) ?? null,
          );
          setEditState('conflict');
        } else if (error instanceof PocketCodeError && error.code === 'OFFLINE') {
          await flushActiveDraft();
          setEditState('dirty');
          setMessage('当前离线，无法保存到电脑；草稿已保留，联网后再保存。');
        } else {
          await flushActiveDraft();
          setEditState('dirty');
          setMessage(error instanceof PocketCodeError ? error.message : '保存失败');
        }
      } finally {
        setSaving(false);
      }
    },
    [
      applyStored,
      cancelPendingAutosave,
      client,
      data,
      enqueue,
      flushActiveDraft,
      initialData.path,
      projectId,
    ],
  );

  const confirmOverwrite = () => {
    if (!conflictVersion) return;
    const confirmed = window.confirm(
      '将用手机上的内容覆盖电脑上的最新版本。\n' +
        '被覆盖的电脑内容已自动保存快照，可恢复。\n确认覆盖？',
    );
    if (confirmed) void saveToPc(conflictVersion);
  };

  const discardAndReload = async () => {
    if (!client || revoked) {
      setMessage('无法从电脑加载最新版本');
      return;
    }
    cancelPendingAutosave();
    setSaving(true);
    try {
      const fresh = await client.readFile(projectId, initialData.path);
      setData(fresh);
      void saveCachedFile(projectId, fresh);
      await enqueue(() => clearDrafts(projectId, initialData.path));
      applyStored({ activeId: null, drafts: [] });
      setEditText(fresh.content);
      baseVersionRef.current = fresh.version;
      setConflictVersion(null);
      setEditState('clean');
      setMode('read');
    } catch (cause) {
      setMessage(cause instanceof PocketCodeError ? cause.message : '加载失败');
    } finally {
      setSaving(false);
    }
  };

  // ---- 草稿切换 / 新建 / 删除 ----
  const switchDraft = async (id: string) => {
    if (id === activeDraftIdRef.current || switchBusy) return;
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
        await flushActiveDraft();
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
    } finally {
      setSwitchBusy(false);
    }
  };

  const createDraft = async () => {
    if (switchBusy) return;
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
        await flushActiveDraft();
      }
      const draft: FileDraft = {
        id: newDraftId(),
        name: name.trim() || `草稿 ${draftsRef.current.length + 1}`,
        path: initialData.path,
        projectId,
        content: editTextRef.current,
        baseVersion: baseVersionRef.current,
        savedAt: new Date().toISOString(),
      };
      const stored = await enqueue(() => upsertDraft(projectId, initialData.path, draft));
      applyStored(stored);
      setEditState((state) => (state === 'clean' ? 'clean' : state));
    } finally {
      setSwitchBusy(false);
    }
  };

  const deleteActiveDraft = async () => {
    const id = activeDraftIdRef.current;
    if (!id || switchBusy) return;
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
    } finally {
      setSwitchBusy(false);
    }
  };

  // ---- Android 返回键：编辑态先退出编辑（草稿保留），阅读态交给上级 ----
  useEffect(() => {
    registerBackGuard(() => {
      if (mode === 'edit') {
        cancelPendingAutosave();
        void flushActiveDraft();
        setMode('read');
        return true;
      }
      return false;
    });
    return () => registerBackGuard(null);
  }, [mode, flushActiveDraft, registerBackGuard, cancelPendingAutosave]);

  const lineCount = (mode === 'edit' ? editText : data.content).split('\n').length;
  const readOnlyBlocked =
    data.read_only || data.encoding === 'utf-16-le' || data.encoding === 'utf-16-be';
  const hasDraft = drafts.length > 0;
  const scrollKey = `file:${projectId}:${initialData.path}`;
  const codeviewRef = useRef<HTMLPreElement | null>(null);

  // 阅读位置记忆（PRD §4.2/§4.3）：回到阅读模式或再次打开同一文件时，
  // 恢复到上次读到的位置。
  useEffect(() => {
    if (mode === 'read') {
      restoreScrollValue(scrollKey, (top) => {
        if (codeviewRef.current) codeviewRef.current.scrollTop = top;
      });
    }
  }, [mode, data.version, scrollKey]);

  return (
    <section>
      <div className="navrow">
        <button
          type="button"
          className="navrow__back"
          onClick={() => {
            if (mode === 'edit') {
              cancelPendingAutosave();
              void flushActiveDraft();
              setMode('read');
            } else {
              onBack();
            }
          }}
        >
          ‹ {mode === 'edit' ? '退出编辑' : '返回'}
        </button>
        <span className="navrow__title">{data.path.split('/').pop()}</span>
      </div>
      <p className="hint">
        {data.path} · {lineCount} 行 · {data.encoding} · {data.newline}
      </p>
      {fromCache ? (
        <p className="hint">
          ⚠ 内容来自本地缓存（{cachedAt?.slice(0, 19).replace('T', ' ')}），
          电脑最新内容以联网刷新为准。
        </p>
      ) : null}
      {mode === 'read' && hasDraft ? (
        <p className="hint">
          有未保存的本地草稿（{drafts[0].name}），点「编辑」继续。
        </p>
      ) : null}
      {message ? (
        <div className="result result--bad">
          <p className="result__title">{message}</p>
        </div>
      ) : null}

      {mode === 'read' ? (
        <>
          <div className="btnrow">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setMode('edit')}
              disabled={readOnlyBlocked || revoked}
            >
              {readOnlyBlocked ? '只读文件' : '✎ 编辑'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void discardAndReload()}
              disabled={!online || revoked || saving}
            >
              刷新电脑版本
            </button>
          </div>
          {revoked ? <p className="hint hint--error">授权已撤销，编辑与刷新不可用。</p> : null}
          <pre
            ref={codeviewRef}
            className="codeview"
            onScroll={(event) => saveScrollValue(scrollKey, event.currentTarget.scrollTop)}
          >
            {data.content}
          </pre>
        </>
      ) : (
        <>
          <div className="editbar">
            <select
              className="editbar__select"
              value={activeDraftId ?? ''}
              onChange={(event) => void switchDraft(event.target.value)}
              disabled={switchBusy}
            >
              {drafts.length === 0 ? <option value="">{AUTOSAVE_NAME}</option> : null}
              {drafts.map((draft) => (
                <option key={draft.id} value={draft.id}>
                  {draft.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="editbar__btn"
              onClick={() => void createDraft()}
              disabled={switchBusy}
            >
              ＋草稿
            </button>
            <button
              type="button"
              className="editbar__btn"
              onClick={() => void deleteActiveDraft()}
              disabled={drafts.length === 0 || switchBusy}
            >
              删除
            </button>
          </div>
          <p className={`hint ${editState === 'conflict' ? 'hint--error' : ''}`}>
            {EDIT_STATE_TEXT[editState]}
            {switchBusy ? ' · 正在切换…' : ''}
          </p>
          {editState === 'conflict' ? (
            <div className="result result--bad">
              <p className="result__title">✘ 电脑上的文件已被其他程序修改</p>
              <p className="result__hint">
                你的草稿基于较早的版本。可选择：用手机内容覆盖电脑（电脑端已有
                快照可恢复）、保留草稿稍后处理，或放弃修改并加载电脑最新版。
              </p>
              <div className="btnrow">
                <button type="button" className="btn btn--primary" onClick={confirmOverwrite}>
                  覆盖电脑文件
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void discardAndReload()}
                  disabled={!online}
                >
                  放弃修改，加载电脑版
                </button>
              </div>
            </div>
          ) : null}
          <textarea
            className="codeview editarea"
            style={{
              display: 'block',
              width: '100%',
              height: 'calc(100vh - 380px)',
              minHeight: 240,
              resize: 'none',
              appearance: 'none',
              WebkitAppearance: 'none',
            }}
            value={editText}
            onChange={(event) => onEditChange(event.target.value)}
            onBlur={() => {
              cancelPendingAutosave();
              if (editStateRef.current === 'dirty' || editStateRef.current === 'conflict') {
                void flushActiveDraft();
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="soft"
          />
          <div className="btnrow">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void saveToPc()}
              disabled={saving || revoked || switchBusy || (editState !== 'dirty' && editState !== 'conflict')}
            >
              {saving ? '保存中…' : '保存到电脑'}
            </button>
          </div>
          {!online ? <p className="hint">当前离线：可以继续编辑，草稿会保留，联网后再保存。</p> : null}
        </>
      )}
    </section>
  );
}
