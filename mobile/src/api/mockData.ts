/**
 * S0 演示数据：目录内容与结构来自 contracts/fixtures 的样例。
 * S2 接入真实 API 后整个文件删除；不作为缓存或草稿的实现依据。
 */

import type { ManifestNode, ProjectSummary } from './types';

export const mockProjects: ProjectSummary[] = [
  { id: 'e1a7c9f0-3b2d-4e5f-8a6b-7c8d9e0f1a2b', name: 'agents-demo', revision: 12 },
  { id: 'f2b8d0a1-4c3e-4f6a-9b7c-8d9e0f1a2b3c', name: 'pocketcode-docs', revision: 3 },
];

/** 故意乱序，验证文件夹在前、文件在后、各组名称排序。 */
export const mockRootChildren: ManifestNode[] = [
  {
    type: 'file',
    name: 'README.md',
    path: 'README.md',
    size: 512,
    mtime: '2026-10-24T10:00:00Z',
    version: 'sha256:3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8e7',
    read_only: false,
  },
  {
    type: 'dir',
    name: 'tests',
    path: 'tests',
    children: [],
  },
  {
    type: 'file',
    name: 'main.py',
    path: 'main.py',
    size: 120,
    mtime: '2026-10-24T09:30:00Z',
    version: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    read_only: false,
  },
  {
    type: 'dir',
    name: 'agents',
    path: 'agents',
    children: [
      {
        type: 'file',
        name: 'react_agent.py',
        path: 'agents/react_agent.py',
        size: 15,
        mtime: '2026-10-24T11:58:30Z',
        version: 'sha256:03e693d9f2f687e0f40e36a8df7fcb4d1c22974012b7c2a55c000eb30f305824',
        read_only: false,
      },
    ],
  },
];
