import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

import type { FileContentResponse, ProjectSummary } from '../api/types';
import { PocketCodeClient, PocketCodeError } from '../api/client';
import { ExplorerScreen } from '../features/explorer/ExplorerScreen';
import { FileScreen } from '../features/explorer/FileScreen';
import { ProjectListScreen } from '../features/projects/ProjectListScreen';
import { ConnectionScreen } from '../features/settings/ConnectionScreen';
import { DraftsScreen } from '../features/drafts/DraftsScreen';
import { DraftEditorScreen } from '../features/drafts/DraftEditorScreen';
import type { FileDraft } from '../storage/draftStore';
import { SearchScreen } from '../features/search/SearchScreen';
import { GitScreen } from '../features/git/GitScreen';
import { ShareScreen } from '../features/sharing/ShareScreen';
import { useConnection } from './useConnection';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { Icon } from '../ui/Icon';
import { closeTopLayer } from './backLayers';
import { CacheScreen } from '../features/settings/CacheScreen';
import { cacheJobs } from '../features/explorer/cacheJobs';
import { rememberFile } from '../storage/readingStore';
import { loadCachedFile, saveCachedFile } from '../storage/cacheStore';

type Screen =
  | { name: 'projects' }
  | { name: 'cache' }
  | { name: 'explorer'; project: ProjectSummary }
  | { name: 'search'; project: ProjectSummary }
  | { name: 'git'; project: ProjectSummary }
  | { name: 'share'; project: ProjectSummary };

type HomeTab = 'projects' | 'drafts' | 'settings';

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
      return { dot: 'offline', text: '未配对 · 点右侧连接电脑' };
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
  const [localDraft, setLocalDraft] = useState<FileDraft | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [homeTab, setHomeTab] = useState<HomeTab>('projects');
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const resumeBusy = useRef(false);
  const cacheBack = useRef<Screen>({ name: 'projects' });
  /** 文件页全屏阅读时为 true：隐藏状态栏与页边距，编辑器占满全屏。 */
  const [immersive, setImmersive] = useState(false);
  const viewerBackGuard = useRef<(() => boolean) | null>(null);
  const viewerHistory = useRef<Viewer[]>([]);
  const navigationId = useRef(0);
  const connectionScroll = useRef(0);
  useEffect(() => {
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, [homeTab]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (showConnection) { connectionScroll.current = window.scrollY; window.scrollTo(0, 0); }
    else window.scrollTo(0, connectionScroll.current);
  }, [showConnection]);
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
    // 定时探测会重新读取配对对象；凭据没变时复用 client，避免各页面反复读缓存。
    [connection.pairing?.baseUrl, connection.pairing?.deviceToken, connection.pairing?.fingerprint],
  );
  useEffect(() => () => { void cacheJobs.stopAll(); }, [client]);
  useEffect(() => { if (revoked) void cacheJobs.stopAll(); }, [revoked]);
  useEffect(() => {
    if (viewer) void rememberFile(viewer.project, viewer.data.path).catch(() => undefined);
  }, [viewer?.project.id, viewer?.data.path]);
  const openCache = () => { cacheBack.current = screen; setScreen({ name: 'cache' }); };
  const resumeFile = async (project: ProjectSummary, path: string) => {
    if (resumeBusy.current || revoked) return;
    resumeBusy.current = true; setResuming(true); setResumeError(null);
    try {
      const cached = await loadCachedFile(project.id, path);
      let data: FileContentResponse | undefined;
      if (client && online) {
        try { data = await client.readFile(project.id, path); void saveCachedFile(project.id, data); }
        catch (cause) {
          // 鉴权/路径/项目错误不得用缓存绕过。
          if (!(cause instanceof PocketCodeError) || cause.code !== 'OFFLINE' || cause.details?.kind === 'tls') throw cause;
        }
      }
      if (!data && !cached) throw new Error('这个文件没有本地缓存，请连接电脑后重试。');
      viewerHistory.current = [];
      setScreen({ name: 'explorer', project });
      setViewer({ project, data: data ?? cached!.data, fromCache: !data, cachedAt: !data ? cached!.fetchedAt : undefined });
    } catch (cause) { setResumeError(cause instanceof Error ? cause.message : '无法继续阅读'); }
    finally { resumeBusy.current = false; setResuming(false); }
  };

  // Android 返回键/侧滑返回：编辑态先退出编辑（草稿保留）→ 逐级回退 → 退出应用。
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handlePromise = CapApp.addListener('backButton', () => {
      if (closeTopLayer()) return;
      if (showConnection) {
        setShowConnection(false);
      } else if (localDraft) {
        viewerBackGuard.current?.();
      } else if (viewer && viewerBackGuard.current?.()) {
        return; // 文件页内部已处理（如退出编辑模式）
      } else if (viewer) {
        backFromViewer();
      } else if (screen.name === 'explorer') {
        setScreen({ name: 'projects' });
      } else if (screen.name === 'cache') {
        setScreen(cacheBack.current);
      } else if (screen.name === 'search' || screen.name === 'git' || screen.name === 'share') {
        setScreen({ name: 'explorer', project: screen.project });
      } else if (homeTab !== 'projects') {
        setHomeTab('projects');
      } else {
        void CapApp.exitApp();
      }
    });
    return () => {
      void handlePromise.then((handle) => handle.remove());
    };
  }, [viewer, localDraft, showConnection, screen.name, homeTab, backFromViewer]);

  const connectionOpen = showConnection;
  const atHome = !connectionOpen && !localDraft && !viewer && screen.name === 'projects';

  const openDraftFromBox = (draft: FileDraft) => {
    setLocalDraft(draft);
  };

  return (
    <div className={`app ${atHome ? 'app--home' : ''}`}>
      <header className={`statusbar ${immersive || localDraft ? 'statusbar--hidden' : ''}`}>
        <span className={`statusbar__dot statusbar__dot--${dot}`} />
        <span className="statusbar__text">{text}</span>
        <button
          type="button"
          className="statusbar__action"
          aria-label={connectionOpen ? '关闭连接管理' : '连接管理'}
          title={connectionOpen ? '关闭连接管理' : '连接管理'}
          onClick={() => setShowConnection((value) => !value)}
        >
          <Icon name={connectionOpen ? 'back' : 'system'} size={18} />
        </button>
      </header>
      <main className={`screen ${immersive || localDraft ? 'screen--immersive' : ''}`}>
        {connectionOpen ? (
          <ConnectionScreen connection={connection} client={client} />
        ) : localDraft ? (
          <DraftEditorScreen
            key={localDraft.id}
            draft={localDraft}
            sourceAvailable={online && !revoked && !!client}
            onBack={() => setLocalDraft(null)}
            registerBackGuard={(guard) => { viewerBackGuard.current = guard; }}
            onOpenSource={async (draft) => {
              if (!client || !online || revoked) throw new Error('来源不可用，草稿仍保存在本机');
              const projects = await client.listProjects();
              const project = projects.projects.find((item) => item.id === draft.projectId);
              if (!project) throw new Error('来源项目已不再授权，仍可继续编辑或导出本地草稿');
              const data = await client.readFile(draft.projectId, draft.path);
              if (data.read_only || data.encoding.startsWith('utf-16')) throw new Error('来源文件当前仅支持只读；可继续编辑和导出本地草稿');
              viewerHistory.current = [];
              setScreen({ name: 'explorer', project });
              setViewer({ project, data, mode: 'edit' });
              setLocalDraft(null);
              setHomeTab('projects');
            }}
          />
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
                { ...viewer, ...origin, line: undefined }].slice(-20);
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
            lastProbe={connection.lastProbe}
            project={screen.project}
            online={online}
            revoked={revoked}
            onBack={() => setScreen({ name: 'projects' })}
            onOpenSearch={() => setScreen({ name: 'search', project: screen.project })}
            onOpenGit={() => setScreen({ name: 'git', project: screen.project })}
            onOpenShare={() => setScreen({ name: 'share', project: screen.project })}
            onOpenCache={openCache}
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
        ) : screen.name === 'cache' ? (
          <CacheScreen client={client} online={online} revoked={revoked} onBack={() => setScreen(cacheBack.current)} />
        ) : screen.name === 'projects' ? (
          homeTab === 'settings' ? (
            <SettingsScreen connectionText={text} onOpenConnection={() => setShowConnection(true)} onOpenCache={openCache} />
          ) : homeTab === 'drafts' ? (
            <DraftsScreen client={revoked ? null : client} online={online && !revoked} onOpenDraft={openDraftFromBox} />
          ) : revoked ? (
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
              lastProbe={connection.lastProbe}
              paired={connection.pairing !== null}
              online={online}
              onOpenProject={(project) => setScreen({ name: 'explorer', project })}
              onResumeFile={(project, path) => { void resumeFile(project, path); }}
              resuming={resuming}
              resumeError={resumeError}
            />
          )
        ) : null}
      </main>
      {/* 底部导航只在首页（项目/草稿箱）出现；进项目/文件后消失（用户要求，避免占空间） */}
      {atHome ? (
        <nav className="bottomnav">
          <button
            type="button"
            className={`bottomnav__btn ${homeTab === 'projects' ? 'bottomnav__btn--active' : ''}`}
            onClick={() => setHomeTab('projects')}
          >
            <Icon name="folder" size={21} /><span>项目</span>
          </button>
          <button
            type="button"
            className={`bottomnav__btn ${homeTab === 'drafts' ? 'bottomnav__btn--active' : ''}`}
            onClick={() => setHomeTab('drafts')}
          >
            <Icon name="drafts" size={21} /><span>草稿箱</span>
          </button>
          <button type="button" className={`bottomnav__btn ${homeTab === 'settings' ? 'bottomnav__btn--active' : ''}`} onClick={() => setHomeTab('settings')}><Icon name="settings" size={21} /><span>设置</span></button>
        </nav>
      ) : null}
    </div>
  );
}
