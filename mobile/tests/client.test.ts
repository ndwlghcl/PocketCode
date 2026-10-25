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
});
