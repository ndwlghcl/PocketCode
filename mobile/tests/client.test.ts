import { describe, expect, it, vi } from 'vitest';

import { PocketCodeClient, PocketCodeError } from '../src/api/client';
import type { TransportFn, TransportRequest, TransportResult } from '../src/api/transport';

function jsonResult(status: number, body: unknown): TransportResult {
  return { status, bodyText: JSON.stringify(body) };
}

function clientOf(transport: TransportFn): PocketCodeClient {
  return new PocketCodeClient({
    baseUrl: 'https://192.168.43.10:8765/',
    token: 'token-abc',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    transport,
  });
}

describe('PocketCodeClient（S2c：传输层 + 指纹）', () => {
  it('Python 静态关联发送草稿正文、符号与行号，不调用保存接口', async () => {
    const transport = vi.fn(async (_request: TransportRequest) => jsonResult(200, {}));
    const client = clientOf(transport);
    await client.pythonContext('p id', { path: 'pkg/main.py', content: 'draft', source: 'draft', symbol: 'make', line: 4 });
    const request = transport.mock.calls[0][0];
    expect(request.method).toBe('POST');
    expect(request.url).toContain('/projects/p%20id/python/context');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ path: 'pkg/main.py', content: 'draft', source: 'draft', symbol: 'make', line: 4 });
  });
  it('Git/恢复保留服务器的路径和项目授权错误', async () => {
    const forbidden = clientOf(async () => jsonResult(403, {
      error: { code: 'PATH_FORBIDDEN', message: '路径越界', request_id: 'r1' },
    }));
    await expect(forbidden.gitDiff('pid', 'linked/code.py', false)).rejects.toMatchObject({
      status: 403, code: 'PATH_FORBIDDEN',
    });
    const removed = clientOf(async () => jsonResult(404, {
      error: { code: 'PROJECT_NOT_FOUND', message: '项目已移除', request_id: 'r2' },
    }));
    await expect(removed.restoreTrash('tid')).rejects.toMatchObject({
      status: 404, code: 'PROJECT_NOT_FOUND',
    });
  });
  it('getHealth 携带指纹并解析响应', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(200, { status: 'ok', protocol_version: '1.0', service: 'pocketcode' }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    const health = await client.getHealth();
    expect(health.service).toBe('pocketcode');

    const req = transport.mock.calls[0]?.[0];
    expect(req?.url).toBe('https://192.168.43.10:8765/v1/health');
    expect(req?.method).toBe('GET');
    expect(req?.fingerprint).toBe('sha256:' + 'a'.repeat(64));
    expect(req?.headers?.Authorization).toBe('Bearer token-abc');
  });

  it('readFile 对相对路径做百分号编码', async () => {
    const transport = vi.fn(async (_req: TransportRequest) => jsonResult(200, {}));
    const client = clientOf(transport as unknown as TransportFn);

    await client.readFile('pid', 'agents/react_agent.py');

    expect(transport.mock.calls[0]?.[0]?.url).toBe(
      'https://192.168.43.10:8765/v1/projects/pid/file?path=agents%2Freact_agent.py',
    );
  });

  it('错误包裹解析为 PocketCodeError（保留 code/request_id/details）', async () => {
    const client = clientOf(
      vi.fn(async () =>
        jsonResult(409, {
          error: {
            code: 'VERSION_CONFLICT',
            message: '电脑文件已在别处修改',
            request_id: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
            details: { current_version: 'sha256:aa' },
          },
        }),
      ) as unknown as TransportFn,
    );

    const err = await client
      .saveFile('pid', {
        path: 'a.py',
        base_version: 'sha256:bb',
        content: 'x',
        encoding: 'utf-8',
        newline: 'LF',
      })
      .catch((e: unknown) => e as PocketCodeError);

    expect(err).toBeInstanceOf(PocketCodeError);
    expect((err as PocketCodeError).status).toBe(409);
    expect((err as PocketCodeError).code).toBe('VERSION_CONFLICT');
    expect((err as PocketCodeError).requestId).toBe('c9bf9e57-1685-4c89-bafb-ff5af830be8a');
    expect((err as PocketCodeError).details).toEqual({ current_version: 'sha256:aa' });
  });

  it('TransportError 映射为客户端本地 OFFLINE（携带失败种类）', async () => {
    const { TransportError } = await import('../src/api/transport');
    const client = clientOf(
      vi.fn(async () => {
        throw new TransportError('network', '无法连接');
      }) as unknown as TransportFn,
    );
    const error = await client.listProjects().catch((e: unknown) => e as PocketCodeError);
    expect(error).toBeInstanceOf(PocketCodeError);
    expect((error as PocketCodeError).code).toBe('OFFLINE');
    expect((error as PocketCodeError).details).toEqual({ kind: 'network' });
  });

  it('204 空响应返回 undefined', async () => {
    const client = clientOf(
      vi.fn(async () => ({ status: 204, bodyText: '' })) as unknown as TransportFn,
    );
    await expect(client.restoreTrash('t-id')).resolves.toBeUndefined();
  });

  it('永久删除和清空回收区使用 DELETE，支持 204 空响应', async () => {
    const transport = vi.fn(async (_req: TransportRequest) => ({ status: 204, bodyText: '' }));
    const client = clientOf(transport);
    await expect(client.deleteTrashEntry('t/id')).resolves.toBeUndefined();
    await expect(client.clearTrash()).resolves.toBeUndefined();
    expect(transport.mock.calls.map(([req]) => [req.method, req.url])).toEqual([
      ['DELETE', 'https://192.168.43.10:8765/v1/trash/t%2Fid'],
      ['DELETE', 'https://192.168.43.10:8765/v1/trash'],
    ]);
    expect(transport.mock.calls.every(([req]) => req.headers?.Authorization === 'Bearer token-abc')).toBe(true);
  });

  it('listTrash 请求 GET /v1/trash 并解析条目列表（S3c）', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(200, {
        items: [
          {
            trash_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            project_id: 'pid',
            original_path: 'old.py',
            deleted_at: '2026-10-25T10:00:00Z',
            kind: 'file',
            size: 12,
          },
        ],
      }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    const response = await client.listTrash();

    expect(transport.mock.calls[0]?.[0]?.url).toBe('https://192.168.43.10:8765/v1/trash');
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.original_path).toBe('old.py');
  });

  it('createEntry 发送 POST /v1/projects/{id}/files（S3c）', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(201, { path: 'docs/笔记.md', type: 'file', manifest_revision: 3 }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    const response = await client.createEntry('pid', { path: 'docs/笔记.md', type: 'file' });

    const req = transport.mock.calls[0]?.[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://192.168.43.10:8765/v1/projects/pid/files');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ path: 'docs/笔记.md', type: 'file' });
    expect(response.manifest_revision).toBe(3);
  });

  it('trashEntries 发送批量路径（S3c）', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(200, { items: [{ path: 'a.txt', trash_id: 't1' }] }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    const response = await client.trashEntries('pid', { paths: ['a.txt', 'sub'] });

    const req = transport.mock.calls[0]?.[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://192.168.43.10:8765/v1/projects/pid/trash');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ paths: ['a.txt', 'sub'] });
    expect(response.items[0]?.trash_id).toBe('t1');
  });

  it('searchProject 对关键词做查询编码（S4b）', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(200, { query: 'serpapi', total_matches: 0, truncated: false, matches: [] }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    await client.searchProject('pid', 'serp api');

    const req = transport.mock.calls[0]?.[0];
    expect(req?.method).toBe('GET');
    // URLSearchParams 把空格编码为 +（服务端按表单规则解码，等价 %20）
    expect(req?.url).toBe('https://192.168.43.10:8765/v1/projects/pid/search?q=serp+api');
  });

  it('diagnose 发送未保存草稿文本（S4d）', async () => {
    const transport = vi.fn(async (_req: TransportRequest) =>
      jsonResult(200, { analyzer: 'ast', diagnostics: [] }),
    );
    const client = clientOf(transport as unknown as TransportFn);

    const response = await client.diagnose('pid', {
      path: 'draft.py',
      content: 'x = 1\n',
    });

    const req = transport.mock.calls[0]?.[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('https://192.168.43.10:8765/v1/projects/pid/diagnose');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ path: 'draft.py', content: 'x = 1\n' });
    expect(response.analyzer).toBe('ast');
  });
});
