// 仅用于独立的 localhost:5175 浏览器 QA；不会进入生产构建或 Android。
import { saveCachedProjects, saveCachedManifest, saveCachedFile } from '../storage/cacheStore';
import { savePairing } from '../storage/pairingStore';
import { upsertDraft } from '../storage/draftStore';
import { rememberFile } from '../storage/readingStore';
import type { ManifestNode, FileContentResponse } from '../api/types';

if (!import.meta.env.DEV || location.hostname !== '127.0.0.1' || location.port !== '5175') {
  throw new Error('界面测试数据只能在独立的 127.0.0.1:5175 开发源中使用');
}
const version = `sha256:${'0'.repeat(64)}` as const;
const mtime = '2026-10-26T07:30:00Z';
const content = `from fastapi import FastAPI

from pocketcode.server.routes.health import router


def create_app():
    """构建 PocketCode 的本地服务。"""
    app = FastAPI(
        title="PocketCode Server",
        docs_url=None,
        redoc_url=None,
    )

    # 按合同注册只读接口
    app.include_router(router)
    return app
`;
const file = (name: string, path: string): ManifestNode => ({ type: 'file', name, path, version, mtime, size: content.length, read_only: false });
await savePairing({ baseUrl: 'https://127.0.0.1:65534', deviceToken: 'ui-fixture-dummy-token-no-real-credentials', fingerprint: version, serverName: '界面测试电脑' });
const projects = [{ id: 'ui-nightfall', name: 'PocketCode', revision: 42 }, { id: 'ui-agent', name: 'my-agent', revision: 18 }, { id: 'ui-notes', name: 'learning-notes', revision: 7 }];
await saveCachedProjects(projects);
const path = 'desktop/pocketcode/server/app.py';
for (const project of projects) {
  await saveCachedManifest(project.id, { revision: project.revision, root: { type: 'dir', name: '', path: '', children: [
    { type: 'dir', name: 'desktop', path: 'desktop', children: [{ type: 'dir', name: 'pocketcode', path: 'desktop/pocketcode', children: [{ type: 'dir', name: 'server', path: 'desktop/pocketcode/server', children: [file('app.py', path), file('schemas.py', 'desktop/pocketcode/server/schemas.py')] }] }] },
    { type: 'dir', name: 'docs', path: 'docs', children: [file('HANDOFF.md', 'docs/HANDOFF.md')] },
    { type: 'dir', name: 'mobile', path: 'mobile', children: [] },
    file('README.md', 'README.md'),
  ] } });
  const data: FileContentResponse = { project_id: project.id, path, content, version, mtime, encoding: 'utf-8', newline: 'LF', size: content.length, read_only: false };
  await saveCachedFile(project.id, data);
}
await upsertDraft('ui-nightfall', path, { id: 'ui-sample-draft', name: '服务路由整理', path, projectId: 'ui-nightfall', content: content + '\n# 一个新的想法\n', baseVersion: version, savedAt: mtime });
await upsertDraft('ui-nightfall', path, { id: 'ui-sample-draft-2', name: '错误处理实验', path, projectId: 'ui-nightfall', content: content.replace('return app', 'return app  # 先记录另一种思路'), baseVersion: version, savedAt: mtime });
await rememberFile(projects[0], path);
location.replace('/');
