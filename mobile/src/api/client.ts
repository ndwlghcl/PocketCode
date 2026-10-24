/**
 * 统一网络客户端：所有对电脑的调用都经过这里，错误统一解析为 PocketCodeError。
 * S0 提供类型与错误解析（可单测）；真实请求在 S1/S2 接入。
 */

import type {
  ErrorResponse,
  FileContentResponse,
  FileCreateRequest,
  FileCreateResponse,
  FileSaveRequest,
  FileSaveResponse,
  HealthResponse,
  ManifestResponse,
  PairCompleteRequest,
  PairCompleteResponse,
  ProjectListResponse,
  RestoreResponse,
  TrashRequest,
  TrashResponse,
} from './types';

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
  /** 例如 http://192.168.43.10:8765 */
  baseUrl: string;
  /** 配对后颁发的设备 token。 */
  token?: string;
  /** 可注入 fetch 便于测试；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 请求超时毫秒数，默认 8000。 */
  timeoutMs?: number;
}

export class PocketCodeClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
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

  async restoreTrash(trashId: string): Promise<RestoreResponse> {
    return this.request('POST', `/v1/trash/${encodeURIComponent(trashId)}/restore`);
  }

  /** 统一请求：非 2xx 时解析错误包裹并抛 PocketCodeError；网络层失败抛 OFFLINE。 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new PocketCodeError(0, OFFLINE_CODE, '无法连接电脑（网络不可达或超时）');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.toPocketCodeError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async toPocketCodeError(response: Response): Promise<PocketCodeError> {
    let parsed: ErrorResponse | null = null;
    try {
      parsed = (await response.json()) as ErrorResponse;
    } catch {
      // 非 JSON 错误体：退化为通用错误
    }
    if (parsed?.error) {
      return new PocketCodeError(
        response.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.request_id,
        parsed.error.details,
      );
    }
    return new PocketCodeError(response.status, 'IO_ERROR', `服务返回异常状态 ${response.status}`);
  }
}
