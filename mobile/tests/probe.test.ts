import { describe, expect, it, vi } from 'vitest';

import {
  normalizeBaseUrl,
  probeHealth,
  type ProbeResult,
} from '../src/api/probe';
import {
  TransportError,
  type TransportFn,
  type TransportRequest,
  type TransportResult,
} from '../src/api/transport';

function jsonResult(status: number, body: unknown): TransportResult {
  return { status, bodyText: JSON.stringify(body) };
}

const HEALTH_BODY = { status: 'ok', protocol_version: '1.0', service: 'pocketcode' };

describe('normalizeBaseUrl', () => {
  it('裸 IP 自动补 https:// 与默认端口 8765', () => {
    expect(normalizeBaseUrl('10.59.163.124')).toBe('https://10.59.163.124:8765');
  });

  it('保留用户指定的协议与端口，去掉路径', () => {
    expect(normalizeBaseUrl('https://10.0.0.2:9000/v1/')).toBe('https://10.0.0.2:9000');
    expect(normalizeBaseUrl('http://pc.example.com')).toBe('http://pc.example.com:8765');
  });

  it('空串与非法输入返回 null', () => {
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('http://')).toBeNull();
    expect(normalizeBaseUrl('ftp://1.2.3.4')).toBeNull();
  });
});

describe('probeHealth（S2c：传输层 + 指纹）', () => {
  it('健康响应 → online 并记录延迟', async () => {
    const transport = vi.fn(async (_req: TransportRequest) => jsonResult(200, HEALTH_BODY));
    const result = await probeHealth('https://10.0.0.2:8765', {
      transport: transport as unknown as TransportFn,
    });

    expect(result.kind).toBe('online');
    if (result.kind !== 'online') throw new Error('unreachable in test');
    expect(result.service).toBe('pocketcode');
    expect(result.protocolVersion).toBe('1.0');
    const req = transport.mock.calls[0]?.[0];
    expect(req?.url).toBe('https://10.0.0.2:8765/v1/health');
  });

  it('已配对探测携带证书指纹', async () => {
    const fingerprint = 'sha256:' + 'b'.repeat(64);
    const transport = vi.fn(async (_req: TransportRequest) => jsonResult(200, HEALTH_BODY));
    await probeHealth('https://10.0.0.2:8765', {
      transport: transport as unknown as TransportFn,
      fingerprint,
    });
    expect(transport.mock.calls[0]?.[0]?.fingerprint).toBe(fingerprint);
  });

  it('传输层失败按种类分类：timeout / tls-mismatch / unreachable', async () => {
    const timeout = await probeHealth('https://10.0.0.2:8765', {
      transport: vi.fn(async () => {
        throw new TransportError('timeout', '连接超时');
      }) as unknown as TransportFn,
    });
    expect(timeout.kind).toBe('timeout');

    const tls = await probeHealth('https://10.0.0.2:8765', {
      transport: vi.fn(async () => {
        throw new TransportError('tls', '证书指纹不匹配');
      }) as unknown as TransportFn,
    });
    expect(tls.kind).toBe('tls-mismatch');

    const network = await probeHealth('https://10.0.0.2:8765', {
      transport: vi.fn(async () => {
        throw new TransportError('network', '无法连接');
      }) as unknown as TransportFn,
    });
    expect(network.kind).toBe('unreachable');
  });

  it('HTTP 500 → http-error；非 PocketCode 服务 → unexpected-response', async () => {
    const serverError = await probeHealth('https://10.0.0.2:8765', {
      transport: vi.fn(async () => jsonResult(500, {})) as unknown as TransportFn,
    });
    expect(serverError).toEqual({ kind: 'http-error', status: 500 });

    const stranger = await probeHealth('https://10.0.0.2:8765', {
      transport: vi.fn(async () => jsonResult(200, { hello: 'world' })) as unknown as TransportFn,
    });
    expect(stranger.kind).toBe('unexpected-response');
  });
});

// 类型层面的编译期检查：确保联合类型被穷尽处理
const _kinds: ProbeResult['kind'][] = [
  'online',
  'timeout',
  'unreachable',
  'tls-mismatch',
  'http-error',
  'unexpected-response',
  'invalid-address',
];
void _kinds;
