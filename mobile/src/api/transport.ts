/**
 * 统一传输层：所有对电脑的请求都经过这里。
 *
 * - 原生（App 内）：走 PocketCodeBridge 原生插件（Kotlin/Java），
 *   由它执行 TLS 并校验证书指纹（WebView 无法信任自签证书，ADR-0004）；
 * - 浏览器开发模式：回退 fetch（自签证书需浏览器手动放行，仅开发用）。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export type TransportErrorKind = 'timeout' | 'tls' | 'network';

export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

export interface TransportRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** JSON 字符串；GET/HEAD 不传。 */
  body?: string;
  /** `sha256:<64hex>`；缺省时仅允许 /v1/health（原生侧强制）。 */
  fingerprint?: string;
  timeoutMs?: number;
}

export interface TransportResult {
  status: number;
  bodyText: string;
}

export type TransportFn = (request: TransportRequest) => Promise<TransportResult>;

/** 原生插件注册（web 下调用会抛"未实现"）。 */
interface PocketCodeBridgePlugin {
  request(options: TransportRequest): Promise<{ status: number; body: string }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureRemove(options: { key: string }): Promise<void>;
}

export const PocketCodeBridge = registerPlugin<PocketCodeBridgePlugin>(
  'PocketCodeBridge',
);

const nativeTransport: TransportFn = async (request) => {
  try {
    const result = await PocketCodeBridge.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      fingerprint: request.fingerprint,
      timeoutMs: request.timeoutMs,
    });
    return { status: result.status, bodyText: result.body };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_TLS') throw new TransportError('tls', (error as Error).message);
    if (code === 'ERR_TIMEOUT') throw new TransportError('timeout', (error as Error).message);
    throw new TransportError('network', (error as Error).message);
  }
};

export function fetchTransport(fetchImpl: typeof fetch = fetch): TransportFn {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 8000);
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new TransportError('timeout', '连接超时');
      }
      throw new TransportError('network', '无法连接电脑');
    } finally {
      clearTimeout(timer);
    }
    return { status: response.status, bodyText: await response.text() };
  };
}

export const platformTransport: TransportFn = Capacitor.isNativePlatform()
  ? nativeTransport
  : fetchTransport();
