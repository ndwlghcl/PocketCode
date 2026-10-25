import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

import type { FileContentResponse, ProjectSummary } from '../api/types';
import { PocketCodeClient } from '../api/client';
import { ExplorerScreen } from '../features/explorer/ExplorerScreen';
import { FileScreen } from '../features/explorer/FileScreen';
import { ProjectListScreen } from '../features/projects/ProjectListScreen';
import { ConnectionScreen } from '../features/settings/ConnectionScreen';
import { useConnection } from './useConnection';

type Screen =
  | { name: 'projects' }
  | { name: 'explorer'; project: ProjectSummary };

interface Viewer {
  project: ProjectSummary;
  data: FileContentResponse;
  fromCache?: boolean;
  cachedAt?: string;
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
  const viewerBackGuard = useRef<(() => boolean) | null>(null);
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
        setViewer(null);
      } else if (showConnection) {
        setShowConnection(false);
      } else if (screen.name === 'explorer') {
        setScreen({ name: 'projects' });
      } else {
        void CapApp.exitApp();
      }
    });
    return () => {
      void handlePromise.then((handle) => handle.remove());
    };
  }, [viewer, showConnection, screen.name]);

  const connectionOpen = showConnection;

  return (
    <div className="app">
      <header className="statusbar">
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
      <main className="screen">
        {connectionOpen ? (
          <ConnectionScreen connection={connection} />
        ) : viewer ? (
          <FileScreen
            client={client}
            projectId={viewer.project.id}
            initialData={viewer.data}
            fromCache={viewer.fromCache}
            cachedAt={viewer.cachedAt}
            online={online}
            revoked={revoked}
            onBack={() => setViewer(null)}
            registerBackGuard={(guard) => {
              viewerBackGuard.current = guard;
            }}
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
          ) : (
            <ProjectListScreen
              client={client}
              paired={connection.pairing !== null}
              online={online}
              onOpenProject={(project) => setScreen({ name: 'explorer', project })}
            />
          )
        ) : (
          <ExplorerScreen
            client={client}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'projects' })}
            onOpenFile={(data, meta) =>
              setViewer({
                project: screen.project,
                data,
                fromCache: meta?.fromCache,
                cachedAt: meta?.cachedAt,
              })
            }
          />
        )}
      </main>
    </div>
  );
}
