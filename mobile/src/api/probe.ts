/**
 * 连接探测（S1→S2c）：对电脑的 /v1/health 做一次带超时的请求，并把结果分类。
 *
 * S2c 起走传输层（原生桥校验指纹）；新增 tls-mismatch 分类——指纹不匹配
 * 说明对方不是配对过的那台电脑，必须明确提示而不是当成普通离线。
 * WebView 的 fetch 无法区分「拒绝连接」和「地址不可解析」，二者都归入
 * `unreachable`；「超时」可靠区分。
 */

import { platformTransport, TransportError, type TransportFn } from './transport';

export type ProbeResult =
  | { kind: 'online'; latencyMs: number; service: string; protocolVersion: string }
  | { kind: 'timeout' }
  | { kind: 'unreachable' }
  | { kind: 'tls-mismatch' }
  | { kind: 'http-error'; status: number }
  | { kind: 'unexpected-response'; detail: string }
  | { kind: 'invalid-address'; message: string };

/** 服务端默认端口：用户只填 IP 时自动补全。 */
export const DEFAULT_PORT = '8765';

/**
 * 把用户输入规整成 `协议://主机:端口`：
 * - 缺协议自动补 https://；缺端口补默认端口；
 * - 已显式带协议时只接受 http/https；
 * - 去掉路径部分（合同固定 /v1 前缀）；
 * - 无法解析返回 null（由界面提示格式错误）。
 */
export function normalizeBaseUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  // 已显式带协议时只接受 http/https（防 ftp:// 之类被拼成 http://ftp:... 混过去）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return null;
  } else {
    raw = `https://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!url.hostname) {
    return null;
  }
  return `${url.protocol}//${url.hostname}:${url.port || DEFAULT_PORT}`;
}

export interface ProbeOptions {
  transport?: TransportFn;
  /** 配对过的电脑必须携带指纹；缺省 = 诊断模式（原生侧仅放行 health）。 */
  fingerprint?: string;
  timeoutMs?: number;
}

export async function probeHealth(
  baseUrl: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const transport = options.transport ?? platformTransport;
  const started = performance.now();
  try {
    const response = await transport({
      url: `${baseUrl}/v1/health`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      fingerprint: options.fingerprint,
      timeoutMs: options.timeoutMs ?? 5000,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'http-error', status: response.status };
    }
    let body: { service?: unknown; protocol_version?: unknown };
    try {
      body = JSON.parse(response.bodyText) as { service?: unknown; protocol_version?: unknown };
    } catch {
      return { kind: 'unexpected-response', detail: '响应不是合法 JSON' };
    }
    if (body.service !== 'pocketcode') {
      return {
        kind: 'unexpected-response',
        detail: '该地址上运行的不是 PocketCode 服务（端口可能被其他程序占用）',
      };
    }
    return {
      kind: 'online',
      latencyMs,
      service: 'pocketcode',
      protocolVersion: typeof body.protocol_version === 'string' ? body.protocol_version : '',
    };
  } catch (error) {
    if (error instanceof TransportError) {
      if (error.kind === 'timeout') return { kind: 'timeout' };
      if (error.kind === 'tls') return { kind: 'tls-mismatch' };
      return { kind: 'unreachable' };
    }
    return { kind: 'unreachable' };
  }
}
