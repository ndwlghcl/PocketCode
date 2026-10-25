/**
 * 统一网络客户端：所有对电脑的调用都经过这里，错误统一解析为 PocketCodeError。
 * S2c 起：请求经传输层（原生桥做 TLS 指纹校验），携带配对时核对的指纹。
 */

import type {
  ErrorResponse,
  FileContentResponse,
  FileCreateRequest,
  FileCreateResponse,
  FileSaveRequest,
  FileSaveResponse,
  DiagnoseRequest,
  DiagnoseResponse,
  GitDiffResponse,
  GitStatusResponse,
  HealthResponse,
  ManifestResponse,
  PairCompleteRequest,
  PairCompleteResponse,
  ProjectListResponse,
  RestoreResponse,
  SearchResponse,
  TrashListResponse,
  TrashRequest,
  TrashResponse,
} from './types';
import { platformTransport, TransportError, type TransportFn } from './transport';

/** 客户端本地状态码（不出现在服务端错误码枚举中）。 */
export const OFFLINE_CODE = 'OFFLINE' as const;

export class PocketCodeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, requestId?: string,
      details?: Record<string, unknown>) {
    super(message);
    this.name = 'PocketCodeError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export interface ClientOptions {
  /** 例如 https://10.59.163.124:8765 */
  baseUrl: string;
  /** 配对后颁发的设备 token。 */
  token?: string;
  /** 配对时核对的证书指纹（sha256:…），原生侧强制校验。 */
  fingerprint?: string;
  /** 可注入传输层便于测试；默认按平台选择。 */
  transport?: TransportFn;
  /** 请求超时毫秒数，默认 8000。 */
  timeoutMs?: number;
}

export class PocketCodeClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fingerprint?: string;
  private readonly transport: TransportFn;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fingerprint = options.fingerprint;
    this.transport = options.transport ?? platformTransport;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request('GET', '/v1/health');
  }

  async completePairing(body: PairCompleteRequest): Promise<PairCompleteResponse> {
    return this.request('POST', '/v1/pair/complete', body);
  }

  async listProjects(): Promise<ProjectListResponse> {
    return this.request('GET', '/v1/projects');
  }

  async getManifest(projectId: string): Promise<ManifestResponse> {
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/manifest`);
  }

  async readFile(projectId: string, path: string): Promise<FileContentResponse> {
    const query = new URLSearchParams({ path });
    return this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/file?${query.toString()}`,
    );
  }

  async saveFile(projectId: string, body: FileSaveRequest): Promise<FileSaveResponse> {
    return this.request('PUT', `/v1/projects/${encodeURIComponent(projectId)}/file`, body);
  }

  async createEntry(projectId: string, body: FileCreateRequest): Promise<FileCreateResponse> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/files`, body);
  }

  async trashEntries(projectId: string, body: TrashRequest): Promise<TrashResponse> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/trash`, body);
  }

  async listTrash(): Promise<TrashListResponse> {
    return this.request('GET', '/v1/trash');
  }

  async searchProject(projectId: string, query: string): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query });
    return this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/search?${params.toString()}`,
    );
  }

  async diagnose(
    projectId: string,
    body: DiagnoseRequest,
  ): Promise<DiagnoseResponse> {
    return this.request(
      'POST',
      `/v1/projects/${encodeURIComponent(projectId)}/diagnose`,
      body,
    );
  }

  async gitStatus(projectId: string): Promise<GitStatusResponse> {
    return this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/git/status`,
    );
  }

  async gitDiff(
    projectId: string,
    path: string,
    staged: boolean,
  ): Promise<GitDiffResponse> {
    const params = new URLSearchParams({ path, staged: staged ? 'true' : 'false' });
    return this.request(
      'GET',
      `/v1/projects/${encodeURIComponent(projectId)}/git/diff?${params.toString()}`,
    );
  }

  async restoreTrash(trashId: string): Promise<RestoreResponse> {
    return this.request('POST', `/v1/trash/${encodeURIComponent(trashId)}/restore`);
  }

  /** 统一请求：非 2xx 时解析错误包裹并抛 PocketCodeError；网络层失败抛 OFFLINE。 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let result;
    try {
      result = await this.transport({
        url: `${this.baseUrl}${path}`,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        fingerprint: this.fingerprint,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new PocketCodeError(0, OFFLINE_CODE, error.message, undefined, {
          kind: error.kind,
        });
      }
      throw error;
    }

    if (result.status >= 400) {
      throw this.toPocketCodeError(result);
    }
    if (result.status === 204 || result.bodyText === '') {
      return undefined as T;
    }
    try {
      return JSON.parse(result.bodyText) as T;
    } catch {
      throw new PocketCodeError(result.status, 'IO_ERROR', '响应不是合法 JSON');
    }
  }

  private toPocketCodeError(result: { status: number; bodyText: string }): PocketCodeError {
    try {
      const parsed = JSON.parse(result.bodyText) as ErrorResponse;
      if (parsed?.error) {
        return new PocketCodeError(
          result.status,
          parsed.error.code,
          parsed.error.message,
          parsed.error.request_id,
          parsed.error.details,
        );
      }
    } catch {
      // 非 JSON 错误体：退化为通用错误
    }
    return new PocketCodeError(result.status, 'IO_ERROR', `服务返回异常状态 ${result.status}`);
  }
}
