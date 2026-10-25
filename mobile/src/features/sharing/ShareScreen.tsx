import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ManifestDir, ProjectSummary } from '../../api/types';
import { PocketCodeClient } from '../../api/client';
import {
  loadCachedFile,
  loadCachedManifest,
  saveCachedFile,
  saveCachedManifest,
} from '../../storage/cacheStore';
import {
  buildMultiFileText,
  bundleTotalChars,
  detectSensitivePaths,
  type BundleFile,
  type ShareSource,
} from '../sharing/bundle';
import { copyText, shareText } from '../sharing/share';

interface Props {
  client: PocketCodeClient | null;
  project: ProjectSummary;
  online: boolean;
  revoked: boolean;
  onBack: () => void;
}

interface FileEntry {
  path: string;
  size: number;
}

interface Preview {
  files: BundleFile[];
  skipped: string[];
  truncated: boolean;
  source: ShareSource;
  fetchedAt: string | null;
}

const MAX_TOTAL_CHARS = 200_000;
const RENDER_CAP = 400;

function flattenFiles(node: ManifestDir, prefix = ''): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const child of node.children) {
    if (child.type === 'dir') {
      entries.push(...flattenFiles(child, `${prefix}${child.name}/`));
    } else {
      entries.push({ path: `${prefix}${child.name}`, size: child.size });
    }
  }
  return entries;
}

/**
 * 多文件分享（S4f，PRD §8.1）：勾选文件 → 预览清单/总大小/来源/敏感提示 →
 * 生成文本包系统分享或复制。在线取电脑版（顺带刷新缓存），离线只用缓存
 * 并明确标注来源。
 */
export function ShareScreen({ client, project, online, revoked, onBack }: Props) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const usable = online && !revoked;

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let root: ManifestDir | null = null;
      let fetchedAt: string | null = null;
      if (client && usable) {
        try {
          const manifest = await client.getManifest(project.id);
          root = manifest.root;
          fetchedAt = manifest.generated_at;
          await saveCachedManifest(project.id, manifest);
        } catch {
          root = null;
        }
      }
      if (!root) {
        const cached = await loadCachedManifest(project.id);
        if (cached) {
          root = cached.root;
          fetchedAt = cached.fetchedAt;
        }
      }
      if (!root) {
        setError(usable ? '目录读取失败' : '离线且没有目录缓存，无法选择文件');
        setFiles([]);
        return;
      }
      setFiles(flattenFiles(root));
      setSelected(new Set());
      setNotice(
        usable
          ? null
          : `离线模式：只能分享已缓存的文件（目录缓存于 ${fetchedAt?.slice(0, 19).replace('T', ' ') ?? '未知时间'}）`,
      );
    } finally {
      setLoading(false);
    }
  }, [client, project.id, usable]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    const all = files ?? [];
    const filtered = needle ? all.filter((file) => file.path.toLowerCase().includes(needle)) : all;
    return filtered.slice(0, RENDER_CAP);
  }, [files, needle]);
  const hiddenCount = (files?.length ?? 0) - visible.length;

  const toggle = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectVisible = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      const allVisible = visible.every((file) => next.has(file.path));
      for (const file of visible) {
        if (allVisible) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  };

  const prepare = async () => {
    if (!files || selected.size === 0 || preparing) return;
    setPreparing(true);
    setError(null);
    try {
      const chosen = files
        .filter((file) => selected.has(file.path))
        .sort((a, b) => a.path.localeCompare(b.path));
      const collected: BundleFile[] = [];
      const skipped: string[] = [];
      let total = 0;
      let truncated = false;
      let source: ShareSource = usable ? 'pc' : 'cache';
      let fetchedAt: string | null = null;

      for (const entry of chosen) {
        let content: string | null = null;
        if (client && usable) {
          try {
            const data = await client.readFile(project.id, entry.path);
            content = data.content;
            fetchedAt = data.mtime;
            void saveCachedFile(project.id, data);
          } catch {
            content = null;
          }
        }
        if (content === null) {
          const cached = await loadCachedFile(project.id, entry.path);
          if (cached) {
            content = cached.data.content;
            fetchedAt = cached.fetchedAt;
            if (source === 'pc') source = 'cache';
          }
        }
        if (content === null) {
          skipped.push(entry.path);
          continue;
        }
        if (total + content.length > MAX_TOTAL_CHARS) {
          truncated = true;
          break;
        }
        total += content.length;
        collected.push({ path: entry.path, content });
      }
      if (collected.length === 0) {
        setError('所选文件都没有可分享的内容（离线且未缓存）。');
        return;
      }
      setPreview({ files: collected, skipped, truncated, source, fetchedAt });
    } finally {
      setPreparing(false);
    }
  };

  const doShare = async () => {
    if (!preview) return;
    const text = buildMultiFileText({
      projectName: project.name,
      files: preview.files,
      source: preview.source,
      fetchedAt: preview.fetchedAt,
    });
    const outcome = await shareText(`多文件分享 · ${project.name}`, text);
    setNotice(
      outcome.ok
        ? outcome.copied
          ? '分享面板不可用，已复制全文到剪贴板'
          : null
        : outcome.message ?? '分享失败',
    );
    if (outcome.ok) setPreview(null);
  };

  const doCopy = async () => {
    if (!preview) return;
    const text = buildMultiFileText({
      projectName: project.name,
      files: preview.files,
      source: preview.source,
      fetchedAt: preview.fetchedAt,
    });
    const outcome = await copyText(text);
    setNotice(outcome.ok ? '已复制全文到剪贴板' : outcome.message ?? '复制失败');
  };

  const sensitive = useMemo(
    () => detectSensitivePaths(preview?.files.map((file) => file.path) ?? []),
    [preview],
  );

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          ‹ 返回
        </button>
        <div className="navrow__stack">
          <span className="navrow__title">分享 · {project.name}</span>
          <span className="navrow__meta">勾选文件生成上下文文本包（给哥哥看）</span>
        </div>
      </div>
      {notice ? (
        <div className="result result--ok">
          <p className="result__title">✔ {notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      <input
        className="field__input"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="按路径过滤文件"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="btnrow">
        <button type="button" className="btn" onClick={selectVisible} disabled={loading}>
          全选/取消可见
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void prepare()}
          disabled={loading || preparing || selected.size === 0}
        >
          {preparing ? '正在生成…' : `下一步（${selected.size}）`}
        </button>
      </div>
      {files === null ? <p className="hint">正在读取文件列表…</p> : null}
      {files !== null && files.length === 0 ? <p className="empty">项目里没有可选文件。</p> : null}
      {hiddenCount > 0 ? (
        <p className="hint">仅显示前 {RENDER_CAP} 条（可用过滤缩小范围），共 {files?.length} 个文件。</p>
      ) : null}
      <ul className="cardlist">
        {visible.map((file) => (
          <li key={file.path}>
            <button type="button" className="cardlist__item" onClick={() => toggle(file.path)}>
              <span className="cardlist__name sharecheck__path">
                {selected.has(file.path) ? '☑' : '☐'} {file.path}
              </span>
              <span className="cardlist__meta">{file.size} B</span>
            </button>
          </li>
        ))}
      </ul>

      {preview ? (
        <>
          <div className="sheet-overlay" onClick={() => setPreview(null)} />
          <div className="sheet">
            <div className="sheet__handle" />
            <p className="sheet__title">分享预览（{preview.files.length} 个文件）</p>
            <p className="sheet__empty">
              来源：{preview.source === 'pc' ? '电脑当前版本' : '本地缓存（可能过期）'}
              {preview.fetchedAt
                ? `（${preview.fetchedAt.slice(0, 19).replace('T', ' ')}）`
                : ''}
              · 共 {bundleTotalChars(preview.files)} 字符
            </p>
            <ul className="sheet__list">
              {preview.files.slice(0, 30).map((file) => (
                <li key={file.path}>
                  <span className="sheet__item">
                    <span className="sheet__name">{file.path}</span>
                  </span>
                </li>
              ))}
              {preview.files.length > 30 ? (
                <li>
                  <span className="sheet__item sheet__empty">
                    …另有 {preview.files.length - 30} 个文件
                  </span>
                </li>
              ) : null}
            </ul>
            {sensitive.length > 0 ? (
              <p className="hint hint--error">
                ⚠ 疑似敏感文件：{sensitive.map((hit) => hit.path).join('、')}。请确认内容不含凭据再分享。
              </p>
            ) : null}
            {preview.skipped.length > 0 ? (
              <p className="hint">跳过 {preview.skipped.length} 个无缓存文件（离线）。</p>
            ) : null}
            {preview.truncated ? (
              <p className="hint hint--error">⚠ 内容超过 20 万字符已截断，只包含部分文件。</p>
            ) : null}
            <div className="btnrow">
              <button type="button" className="btn" onClick={() => void doCopy()}>
                复制全文
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void doShare()}
              >
                系统分享
              </button>
            </div>
            <div className="btnrow">
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
