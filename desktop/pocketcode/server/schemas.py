"""服务端 Pydantic 模型：与 contracts/openapi.yaml 严格对齐。

规则：本文件只允许定义合同中已存在的字段；新增字段必须先改合同。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    """GET /v1/health 响应。字段与 fixtures/health_ok.json 一致。"""

    status: Literal["ok", "degraded"] = "ok"
    protocol_version: str = "1.0"
    service: str = "pocketcode"


class ErrorBody(BaseModel):
    """统一错误体。详见 contracts/errors.md。"""

    code: str
    message: str
    request_id: str
    details: dict[str, object] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody


class ProjectSummary(BaseModel):
    """GET /v1/projects 列表项。字段与合同 ProjectSummary 一致。"""

    id: str
    name: str
    revision: int


class ProjectListResponse(BaseModel):
    projects: list[ProjectSummary]


class PairCompleteRequest(BaseModel):
    """POST /v1/pair/complete 请求体（合同 PairCompleteRequest）。"""

    pairing_code: str = Field(min_length=6, max_length=32, pattern=r"^[A-Z0-9-]+$")
    device_name: str = Field(min_length=1, max_length=64)
    device_platform: str = Field(min_length=1, max_length=32)


class PairCompleteResponse(BaseModel):
    """配对成功响应；device_token 仅此一次返回。"""

    device_id: str
    device_token: str
    server_id: str
    server_name: str


class ManifestDir(BaseModel):
    type: Literal["dir"]
    name: str
    path: str
    children: list["ManifestNode"]


class ManifestFile(BaseModel):
    type: Literal["file"]
    name: str
    path: str
    size: int
    mtime: str
    version: str
    read_only: bool


ManifestNode = ManifestDir | ManifestFile

ManifestDir.model_rebuild()


class ManifestResponse(BaseModel):
    project_id: str
    revision: int
    generated_at: str
    truncated: bool
    root: ManifestDir


class FileContentResponse(BaseModel):
    project_id: str
    path: str
    content: str
    encoding: Literal["utf-8", "utf-8-bom", "utf-16-le", "utf-16-be"]
    newline: Literal["LF", "CRLF", "CR"]
    version: str
    size: int
    mtime: str
    read_only: bool


# ---------------------------------------------------------------- S3 写入
class FileSaveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    base_version: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    # 内容大小不在此处拦截：>4MiB 必须由服务层返回 413 FILE_TOO_LARGE，
    # 而不是请求校验层的 400。
    content: str
    encoding: Literal["utf-8", "utf-8-bom", "utf-16-le", "utf-16-be"]
    newline: Literal["LF", "CRLF", "CR"]


class FileSaveResponse(BaseModel):
    path: str
    version: str
    size: int
    mtime: str


class FileCreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    type: Literal["file", "dir"]
    content: str = ""  # 大小由服务层校验（超限 413）
    encoding: Literal["utf-8", "utf-8-bom", "utf-16-le", "utf-16-be"] = "utf-8"
    newline: Literal["LF", "CRLF", "CR"] = "LF"


class FileCreateResponse(BaseModel):
    path: str
    type: Literal["file", "dir"]
    version: str | None = None
    manifest_revision: int


class TrashRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


class TrashItem(BaseModel):
    path: str
    trash_id: str


class TrashResponse(BaseModel):
    items: list[TrashItem]


class TrashEntry(BaseModel):
    trash_id: str
    project_id: str
    original_path: str
    deleted_at: str
    kind: Literal["file", "dir"]
    size: int | None = None


class TrashListResponse(BaseModel):
    items: list[TrashEntry]


class RestoreResponse(BaseModel):
    trash_id: str
    restored_path: str


# ---------------------------------------------------------------- S4 搜索
class SearchLineMatch(BaseModel):
    line: int = Field(ge=1)
    text: str


class SearchFileMatches(BaseModel):
    path: str
    lines: list[SearchLineMatch]


class SearchResponse(BaseModel):
    query: str
    total_matches: int = Field(ge=0)
    truncated: bool
    matches: list[SearchFileMatches]


# ---------------------------------------------------------------- S4 诊断
class DiagnoseRequest(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    content: str


class Diagnostic(BaseModel):
    line: int = Field(ge=1)
    column: int = Field(ge=1)
    severity: Literal["error", "warning"]
    code: str
    message: str


class DiagnoseResponse(BaseModel):
    analyzer: str
    diagnostics: list[Diagnostic]


# ---------------------------------------------------------------- S4 Git
class GitFileStatus(BaseModel):
    path: str
    index_status: Literal[
        "none", "added", "modified", "deleted", "renamed", "copied", "typechange", "conflicted"
    ]
    worktree_status: Literal[
        "none", "added", "modified", "deleted", "renamed", "copied", "typechange",
        "untracked", "conflicted",
    ]


class GitStatusResponse(BaseModel):
    available: bool
    reason: str | None = None
    branch: str | None = None
    changes: list[GitFileStatus]


class GitDiffResponse(BaseModel):
    path: str
    diff: str
    truncated: bool
