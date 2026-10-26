import { Icon } from '../../ui/Icon';
import { useCallback, useEffect, useState } from 'react';

import type { GitDiffResponse, GitStatusResponse, ProjectSummary } from '../../api/types';
import { PocketCodeClient, PocketCodeError } from '../../api/client';
import { copyText, shareText } from '../sharing/share';

interface Props {
  client: PocketCodeClient | null;
  project: ProjectSummary;
  online: boolean;
  revoked: boolean;
  onBack: () => void;
}

/** 状态徽章文案。 */
const STATUS_LABEL: Record<string, string> = {
  none: '',
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  typechange: '类型变更',
  untracked: '未跟踪',
  conflicted: '冲突',
};

/**
 * 项目 Git 页（S4e，只读）：分支 + 未提交修改清单 + 单文件 Diff。
 * 不是 git 仓库时给出说明（正常状态，不是报错）。
 */
export function GitScreen({ client, project, online, revoked, onBack }: Props) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!client || !online || revoked) return;
    setLoading(true);
    setError(null);
    try {
      const response = await client.gitStatus(project.id);
      setStatus(response);
      setExpandedPath(null);
      setDiff(null);
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof PocketCodeError ? cause.message : '读取 Git 状态失败');
    } finally {
      setLoading(false);
    }
  }, [client, online, project.id, revoked]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const toggleDiff = async (path: string, indexStatus: string, worktreeStatus: string) => {
    if (!client) return;
    if (expandedPath === path) {
      setExpandedPath(null);
      setDiff(null);
      return;
    }
    setExpandedPath(path);
    setDiff(null);
    setDiffLoading(true);
    setNotice(null);
    try {
      // 只有暂存改动（工作区干净）时看 --cached，否则看工作区 diff
      const staged = worktreeStatus === 'none' && indexStatus !== 'none';
      const response = await client.gitDiff(project.id, path, staged);
      setDiff(response);
    } catch (cause) {
      setError(cause instanceof PocketCodeError ? cause.message : '读取 Diff 失败');
      setExpandedPath(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const shareDiff = async () => {
    if (!diff || !diff.diff) return;
    setNotice(null);
    const outcome = await shareText(`Git Diff · ${diff.path}`, diff.diff);
    setNotice(
      outcome.ok
        ? outcome.copied
          ? '分享面板不可用，已复制 Diff 到剪贴板'
          : null
        : outcome.message ?? '分享失败',
    );
  };

  const copyDiff = async () => {
    if (!diff || !diff.diff) return;
    setNotice(null);
    const outcome = await copyText(diff.diff);
    setNotice(outcome.ok ? '已复制 Diff 到剪贴板' : outcome.message ?? '复制失败');
  };

  const usable = online && !revoked;

  return (
    <section>
      <div className="navrow">
        <button type="button" className="navrow__back" onClick={onBack}>
          <Icon name="back" size={20} /><span className="visually-hidden">返回目录</span>
        </button>
        <div className="navrow__stack">
          <span className="navrow__title">Git · {project.name}</span>
          <span className="navrow__meta">
            {status?.available && status.branch ? `分支 ${status.branch}` : '只读：不做任何 Git 写操作'}
          </span>
        </div>
      </div>
      <div className="btnrow">
        <button
          type="button"
          className="btn"
          onClick={() => void loadStatus()}
          disabled={!usable || loading}
        >
          {loading ? '正在刷新…' : '刷新状态'}
        </button>
      </div>
      {!usable ? (
        <p className="hint">{revoked ? '授权已撤销。' : '离线时无法读取电脑上的 Git 状态。'}</p>
      ) : null}
      {error ? (
        <div className="result result--bad">
          <p className="result__title">✘ {error}</p>
        </div>
      ) : null}
      {notice ? (
        <div className="result result--ok">
          <p className="result__title">✔ {notice}</p>
        </div>
      ) : null}
      {status && !status.available ? (
        <p className="empty">
          这个项目读不到 Git 信息：{status.reason ?? '未知原因'}。其余功能不受影响。
        </p>
      ) : null}
      {status?.available && status.changes.length === 0 ? (
        <p className="empty">工作区干净：没有未提交的修改。</p>
      ) : null}
      <ul className="cardlist">
        {(status?.changes ?? []).map((change) => (
          <li key={`${change.path}:${change.index_status}:${change.worktree_status}`}>
            <div className="gititem">
              <button
                type="button"
                className="gititem__row"
                onClick={() =>
                  void toggleDiff(change.path, change.index_status, change.worktree_status)
                }
              >
                <span className="gititem__path">{change.path}</span>
                <span className="gititem__badges">
                  {change.index_status !== 'none' ? (
                    <span className="gititem__badge gititem__badge--staged">
                      暂存·{STATUS_LABEL[change.index_status]}
                    </span>
                  ) : null}
                  {change.worktree_status !== 'none' ? (
                    <span className={`gititem__badge ${change.worktree_status === 'untracked' ? 'gititem__badge--untracked' : ''}`}>
                      {STATUS_LABEL[change.worktree_status]}
                    </span>
                  ) : null}
                  <span className="gititem__chevron">
                    {expandedPath === change.path ? '▾' : '▸'}
                  </span>
                </span>
              </button>
              {expandedPath === change.path ? (
                <div className="gititem__diffwrap">
                  {diffLoading ? <p className="hint">正在读取 Diff…</p> : null}
                  {diff && !diff.diff ? (
                    <p className="hint">没有 Diff 内容（未跟踪的新文件或已无差异）。</p>
                  ) : null}
                  {diff && diff.diff ? (
                    <>
                      <pre className="diffview">
                        {diff.diff.split('\n').map((line, index) => (
                          <span
                            key={index}
                            className={
                              line.startsWith('+') && !line.startsWith('+++')
                                ? 'diff-add'
                                : line.startsWith('-') && !line.startsWith('---')
                                  ? 'diff-del'
                                  : line.startsWith('@@')
                                    ? 'diff-hunk'
                                    : undefined
                            }
                          >
                            {line}
                            {'\n'}
                          </span>
                        ))}
                      </pre>
                      {diff.truncated ? (
                        <p className="hint hint--error">⚠ Diff 过长已截断（256 KiB）。</p>
                      ) : null}
                      <div className="btnrow">
                        <button type="button" className="btn" onClick={() => void copyDiff()}>
                          复制
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => void shareDiff()}
                        >
                          分享 Diff
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
