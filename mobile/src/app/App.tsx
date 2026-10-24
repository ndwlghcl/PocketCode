import { useState } from 'react';
import type { ProjectSummary } from '../api/types';
import { ExplorerScreen } from '../features/explorer/ExplorerScreen';
import { mockProjects, mockRootChildren } from '../api/mockData';
import { ProjectListScreen } from '../features/projects/ProjectListScreen';

type Screen =
  | { name: 'projects' }
  | { name: 'explorer'; project: ProjectSummary };

/**
 * S0 根导航：启动进入项目列表（PRD 决策）。
 * 数据目前来自 mockData（合同样例），S2 接入真实 API 与缓存。
 */
export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'projects' });

  return (
    <div className="app">
      <header className="statusbar">
        <span className="statusbar__dot statusbar__dot--offline" />
        <span>S0 骨架 · 离线（S1 接入连接诊断，S2 接入配对与真实数据）</span>
      </header>
      <main className="screen">
        {screen.name === 'projects' ? (
          <ProjectListScreen
            projects={mockProjects}
            onOpenProject={(project) => setScreen({ name: 'explorer', project })}
          />
        ) : (
          <ExplorerScreen
            project={screen.project}
            rootChildren={mockRootChildren}
            onBack={() => setScreen({ name: 'projects' })}
          />
        )}
      </main>
    </div>
  );
}
