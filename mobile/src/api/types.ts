/**
 * 与 contracts/openapi.yaml 对齐的 TypeScript 类型。
 *
 * S0 为手写对齐（以合同文件为真源）；S2 起改为从 openapi.yaml 生成，
 * 生成前不得在本文件添加合同之外的字段。
 */

/** 文件原始字节的 SHA-256 版本标识。 */
export type Sha256Version = `sha256:${string}`;

/** 项目内相对路径（规则见合同 RelativePath）。 */
export type RelativePath = string;

export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16-le' | 'utf-16-be';

export type NewlineStyle = 'LF' | 'CRLF' | 'CR';

/** 服务端错误码全集（OFFLINE 为客户端本地状态，不在其中）。 */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'DEVICE_REVOKED'
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_USED'
  | 'PAIRING_REJECTED'
  | 'PAIRING_TIMEOUT'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PROJECT_NOT_FOUND'
  | 'PATH_INVALID'
  | 'PATH_FORBIDDEN'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'FILE_TOO_LARGE'
  | 'VERSION_CONFLICT'
  | 'ALREADY_EXISTS'
  | 'IO_ERROR';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  protocol_version: string;
  service: string;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  request_id: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponse {
  error: ApiErrorBody;
}

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
}

export interface ManifestDir {
  type: 'dir';
  name: string;
  path: string;
  children: ManifestNode[];
}

export interface ManifestFile {
  type: 'file';
  name: string;
  path: RelativePath;
  size: number;
  mtime: string;
  version: Sha256Version;
  read_only: boolean;
}

export type ManifestNode = ManifestDir | ManifestFile;

export interface ManifestResponse {
  project_id: string;
  revision: number;
  generated_at: string;
  truncated: boolean;
  root: ManifestDir;
}

export interface FileContentResponse {
  project_id: string;
  path: RelativePath;
  content: string;
  encoding: TextEncoding;
  newline: NewlineStyle;
  version: Sha256Version;
  size: number;
  mtime: string;
  read_only: boolean;
}

export interface FileSaveRequest {
  path: RelativePath;
  /** sha256:<64hex>；服务端强制校验格式与冲突。 */
  base_version: string;
  content: string;
  encoding: TextEncoding;
  newline: NewlineStyle;
}

export interface FileSaveResponse {
  path: RelativePath;
  version: Sha256Version;
  size: number;
  mtime: string;
}

export interface FileCreateRequest {
  path: RelativePath;
  type: 'file' | 'dir';
  content?: string;
  encoding?: TextEncoding;
  newline?: NewlineStyle;
}

export interface FileCreateResponse {
  path: RelativePath;
  type: 'file' | 'dir';
  version?: Sha256Version;
  manifest_revision: number;
}

export interface TrashRequest {
  paths: RelativePath[];
}

export interface TrashItem {
  path: RelativePath;
  trash_id: string;
}

export interface TrashResponse {
  items: TrashItem[];
}

export interface RestoreResponse {
  trash_id: string;
  restored_path: RelativePath;
}

export interface PairCompleteRequest {
  pairing_code: string;
  device_name: string;
  device_platform: string;
}

export interface PairCompleteResponse {
  device_id: string;
  device_token: string;
  server_id: string;
  server_name: string;
}
