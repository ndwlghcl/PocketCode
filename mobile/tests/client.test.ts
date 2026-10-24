import { describe, expect, it, vi } from 'vitest';

import { PocketCodeClient, PocketCodeError } from '../src/api/client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>): PocketCodeClient {
  return new PocketCodeClient({
    baseUrl: 'http://192.168.43.10:8765/',
    token: 'token-abc',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return call as unknown as [string, RequestInit];
}

describe('PocketCodeClient', () => {
  it('getHealth 请求正确 URL 与头并解析响应', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { status: 'ok', protocol_version: '1.0', service: 'pocketcode' }),
    );
    const client = clientWith(fetchMock);

    const health = await client.getHealth();

    expect(health.service).toBe('pocketcode');
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe('http://192.168.43.10:8765/v1/health');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-abc');
  });

  it('readFile 对相对路径做百分号编码', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const client = clientWith(fetchMock);

    await client.readFile('pid', 'agents/react_agent.py');

    const [url] = lastCall(fetchMock);
    expect(url).toBe(
      'http://192.168.43.10:8765/v1/projects/pid/file?path=agents%2Freact_agent.py',
    );
  });

  it('错误包裹解析为 PocketCodeError（保留 code/request_id/details）', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        error: {
          code: 'VERSION_CONFLICT',
          message: '电脑文件已在别处修改',
          request_id: 'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
          details: { current_version: 'sha256:aa' },
        },
      }),
    );
    const client = clientWith(fetchMock);

    const err = await client.saveFile('pid', {
      path: 'a.py',
      base_version: 'sha256:bb',
      content: 'x',
      encoding: 'utf-8',
      newline: 'LF',
    }).catch((e: unknown) => e as PocketCodeError);

    expect(err).toBeInstanceOf(PocketCodeError);
    expect((err as PocketCodeError).status).toBe(409);
    expect((err as PocketCodeError).code).toBe('VERSION_CONFLICT');
    expect((err as PocketCodeError).requestId).toBe('c9bf9e57-1685-4c89-bafb-ff5af830be8a');
    expect((err as PocketCodeError).details).toEqual({ current_version: 'sha256:aa' });
  });

  it('网络失败映射为客户端本地 OFFLINE 错误', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const client = clientWith(fetchMock);

    await expect(client.listProjects()).rejects.toMatchObject({ code: 'OFFLINE' });
  });
});
