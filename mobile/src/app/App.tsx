import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

import type { FileContentResponse, ProjectSummary } from '../api/types';
import { PocketCodeClient } from '../api/client';
import { ExplorerScreen } from '../features/explorer/ExplorerScreen';
import { FileScreen } from '../features/explorer/FileScreen';
import { ProjectListScreen } from '../features/projects/ProjectListScreen';
import { ConnectionScreen } from '../features/settings/ConnectionScreen';
import { DraftsScreen } from '../features/drafts/DraftsScreen';
import { SearchScreen } from '../features/search/SearchScreen';
import { GitScreen } from '../features/git/GitScreen';
import { ShareScreen } from '../features/sharing/ShareScreen';
import { useConnection } from './useConnection';

type Screen =
  | { name: 'projects' }
  | { name: 'explorer'; project: ProjectSummary }
  | { name: 'search'; project: ProjectSummary }
  | { name: 'git'; project: ProjectSummary }
  | { name: 'share'; project: ProjectSummary };

type HomeTab = 'projects' | 'drafts';

interface Viewer {
  project: ProjectSummary;
  data: FileContentResponse;
  fromCache?: boolean;
  cachedAt?: string;
  /** 搜索结果定位：打开后跳到的行（1-based）。 */
  line?: number;
  navigationId?: number;
  mode?: 'read' | 'edit';
}

function statusView(connection: ReturnType<typeof useConnection>): {
  dot: 'ok' | 'offline' | 'unknown' | 'warn';
  text: string;
} {
  const { status, pairing } = connection;
  switch (status.state) {
    case 'online':
      return {
        dot: 'ok',
        text: `已连接 ${pairing?.serverName ?? pairing?.baseUrl ?? ''} · ${status.latencyMs}ms`,
      };
    case 'offline':
      return { dot: 'offline', text: `离线 ${pairing?.baseUrl ?? ''}` };
    case 'revoked':
      return { dot: 'warn', text: '授权已被电脑撤销' };
    case 'tls-mismatch':
      return { dot: 'warn', text: '证书校验失败 · 对方不是配对的电脑' };
    case 'probing':
      return { dot: 'unknown', text: '正在检查连接…' };
    case 'unpaired':
      return { dot: 'offline', text: '未配对 · 点右侧「连接」扫码' };
  }
}

/**
 * S2c 根导航：项目列表（真实数据 + 离线缓存）、阅读页、连接页（状态栏入口）。
 * Android 返回键/手势：文件 → 目录 → 项目列表 → 退出，与页面层级一致。
 */
export function App() {
  const connection = useConnection();
  const [screen, setScreen] = useState<Screen>({ name: 'projects' });
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [homeTab, setHomeTab] = useState<HomeTab>('projects');
  /** 文件页全屏阅读时为 true：隐藏状态栏与页边距，编辑器占满全屏。 */
  const [immersive, setImmersive] = useState(false);
  const viewerBackGuard = useRef<(() => boolean) | null>(null);
  const viewerHistory = useRef<Viewer[]>([]);
  const navigationId = useRef(0);
  const backFromViewer = useCallback(() => {
    setViewer(viewerHistory.current.pop() ?? null);
  }, []);
  const { dot, text } = statusView(connection);

  const online = connection.status.state === 'online';
  const revoked = connection.status.state === 'revoked';
  const client = useMemo(
    () =>
      connection.pairing
        ? new PocketCodeClient({
            baseUrl: connection.pairing.baseUrl,
            token: connection.pairing.deviceToken,
            fingerprint: connection.pairing.fingerprint,
          })
        : null,
    [connection.pairing],
  );

  // Android 返回键/侧滑返回：编辑态先退出编辑（草稿保留）→ 逐级回退 → 退出应用。
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handlePromise = CapApp.addListener('backButton', () => {
      if (viewer && viewerBackGuard.current?.()) {
        return; // 文件页内部已处理（如退出编辑模式）
      }
      if (viewer) {
        backFromViewer();
      } else if (showConnection) {
        setShowConnection(false);
      } else if (screen.name === 'explorer') {
        setScreen({ name: 'projects' });
      } else if (screen.name === 'search' || screen.name === 'git' || screen.name === 'share') {
        setScreen({ name: 'explorer', project: screen.project });
      } else if (homeTab === 'drafts') {
        setHomeTab('projects');
      } else {
        void CapApp.exitApp();
      }
    });
    return () => {
      void handlePromise.then((handle) => handle.remove());
    };
  }, [viewer, showConnection, screen.name, homeTab, backFromViewer]);

  const connectionOpen = showConnection;
  const atHome = !connectionOpen && !viewer && screen.name === 'projects';

  const openDraftFromBox = (
    project: ProjectSummary,
    data: FileContentResponse,
    meta?: { fromCache?: boolean; cachedAt?: string },
  ) => {
    setHomeTab('projects');
    viewerHistory.current = [];
    setScreen({ name: 'explorer', project });
    setViewer({ project, data, fromCache: meta?.fromCache, cachedAt: meta?.cachedAt });
  };

  return (
    <div className="app">
      <header className={`statusbar ${immersive ? 'statusbar--hidden' : ''}`}>
        <span className={`statusbar__dot statusbar__dot--${dot}`} />
        <span className="statusbar__text">{text}</span>
        <button
          type="button"
          className="statusbar__action"
          onClick={() => setShowConnection((value) => !value)}
        >
          {connectionOpen ? '‹ 返回' : '⚙ 连接'}
        </button>
      </header>
      <main className={`screen ${immersive ? 'screen--immersive' : ''}`}>
        {connectionOpen ? (
          <ConnectionScreen connection={connection} client={client} />
        ) : viewer ? (
          <FileScreen
            key={`${viewer.project.id}:${viewer.data.path}:${viewer.navigationId ?? 0}`}
            client={client}
            projectId={viewer.project.id}
            initialData={viewer.data}
            fromCache={viewer.fromCache}
            cachedAt={viewer.cachedAt}
            online={online}
            revoked={revoked}
            onBack={backFromViewer}
            projectName={viewer.project.name}
            initialMode={viewer.mode}
            onOpenRelated={(data, line, origin) => {
              // 返回原文件时恢复持久阅读位置，不再次执行最初的搜索跳行。
              viewerHistory.current = [...viewerHistory.current,
                { ...viewer, data: origin.data, mode: origin.mode, line: undefined }].slice(-20);
              setViewer({ project: viewer.project, data, line, navigationId: ++navigationId.current });
            }}
            registerBackGuard={(guard) => {
              viewerBackGuard.current = guard;
            }}
            onImmersiveChange={setImmersive}
            initialLine={viewer.line}
          />
        ) : screen.name === 'explorer' ? (
          <ExplorerScreen
            client={client}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'projects' })}
            onOpenSearch={() => setScreen({ name: 'search', project: screen.project })}
            onOpenGit={() => setScreen({ name: 'git', project: screen.project })}
            onOpenShare={() => setScreen({ name: 'share', project: screen.project })}
            onOpenFile={(data, meta) =>
              setViewer({
                project: screen.project,
                data,
                fromCache: meta?.fromCache,
                cachedAt: meta?.cachedAt,
              })
            }
          />
        ) : screen.name === 'search' ? (
          <SearchScreen
            client={client}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'explorer', project: screen.project })}
            onOpenFile={(data, meta, line) =>
              setViewer({
                project: screen.project,
                data,
                fromCache: meta?.fromCache,
                cachedAt: meta?.cachedAt,
                line,
              })
            }
          />
        ) : screen.name === 'git' ? (
          <GitScreen
            client={client}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'explorer', project: screen.project })}
          />
        ) : screen.name === 'share' ? (
          <ShareScreen
            client={client}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'explorer', project: screen.project })}
          />
        ) : screen.name === 'projects' ? (
          revoked ? (
            <section>
              <h1 className="screen__title">项目</h1>
              <div className="result result--bad">
                <p className="result__title">
                  ✘ 本手机的授权已被电脑撤销
                </p>
                <p className="result__hint">
                  电脑端撤销后令牌立即失效。如需继续使用，请在电脑端重新生成
                  二维码并扫码配对。
                </p>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setShowConnection(true)}
                >
                  去重新配对
                </button>
              </div>
            </section>
          ) : homeTab === 'drafts' ? (
            <DraftsScreen client={client} online={online} onOpenDraft={openDraftFromBox} />
          ) : (
            <ProjectListScreen
              client={client}
              paired={connection.pairing !== null}
              online={online}
              onOpenProject={(project) => setScreen({ name: 'explorer', project })}
            />
          )
        ) : null}
      </main>
      {/* 底部导航只在首页（项目/草稿箱）出现；进项目/文件后消失（用户要求，避免占空间） */}
      {atHome && !revoked ? (
        <nav className="bottomnav">
          <button
            type="button"
            className={`bottomnav__btn ${homeTab === 'projects' ? 'bottomnav__btn--active' : ''}`}
            onClick={() => setHomeTab('projects')}
          >
            项目
          </button>
          <button
            type="button"
            className={`bottomnav__btn ${homeTab === 'drafts' ? 'bottomnav__btn--active' : ''}`}
            onClick={() => setHomeTab('drafts')}
          >
            草稿箱
          </button>
        </nav>
      ) : null}
    </div>
  );
}
