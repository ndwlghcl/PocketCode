"""GET /v1/projects、/manifest、/file —— 授权项目与只读文件接口（S2a/S2c）。

必须通过设备令牌鉴权；未配对的请求一律 401。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request

from pocketcode.security.auth import DeviceIdentity, require_device
from pocketcode.security.path_guard import PathGuardError, validate_relative_path
from pocketcode.server.errors import ApiError
from pocketcode.server.schemas import (
    DiagnoseRequest,
    DiagnoseResponse,
    FileContentResponse,
    GitDiffResponse,
    GitStatusResponse,
    ManifestResponse,
    ProjectListResponse,
    ProjectSummary,
    SearchResponse,
)
from pocketcode.services.diagnostics import DiagnoseServiceError, diagnose_python_source
from pocketcode.services.files import (
    FileServiceError,
    generate_manifest,
    manifest_signature,
    project_root_or_404,
    read_text_file,
)
from pocketcode.services.gitinfo import GitServiceError, git_diff, git_status
from pocketcode.services.search import SearchServiceError, search_project

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device)])


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _translate(exc: FileServiceError) -> ApiError:
    raise ApiError(exc.code, exc.message) from exc


@router.get(
    "/projects",
    response_model=ProjectListResponse,
    status_code=200,
    summary="返回全部已授权项目",
)
def list_projects(request: Request) -> ProjectListResponse:
    store = request.app.state.store
    settings = store.load()
    return ProjectListResponse(
        projects=[
            ProjectSummary(id=p.id, name=p.name, revision=p.revision)
            for p in settings.authorized_projects
        ]
    )


@router.get(
    "/projects/{project_id}/manifest",
    response_model=ManifestResponse,
    status_code=200,
    summary="返回项目完整目录元数据快照",
    responses={404: {"description": "项目不存在"}},
)
def get_manifest(project_id: str, request: Request) -> ManifestResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
        root_node, truncated = generate_manifest(root)
        revision = store.record_manifest_revision(project_id, manifest_signature(root_node))
    except FileServiceError as exc:
        _translate(exc)
    return ManifestResponse(
        project_id=project_id,
        revision=revision,
        generated_at=_utc_now_iso(),
        truncated=truncated,
        root=root_node,
    )


@router.get(
    "/projects/{project_id}/file",
    response_model=FileContentResponse,
    status_code=200,
    summary="读取一个文本文件的内容与元数据",
    responses={
        400: {"description": "路径不符合合同规则"},
        403: {"description": "路径越出授权目录"},
        404: {"description": "项目或文件不存在"},
        413: {"description": "文件超过大小上限"},
        415: {"description": "二进制或不支持的编码"},
    },
)
def read_file(
    project_id: str,
    request: Request,
    path: str = Query(min_length=1, max_length=512),
) -> FileContentResponse:
    # 语法层校验先做（含 ..、反斜杠等），越界类错误由 resolve 层给出 403
    try:
        validate_relative_path(path)
    except PathGuardError as exc:
        raise ApiError(exc.code, exc.message) from exc
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
        fields = read_text_file(root, path)
    except FileServiceError as exc:
        _translate(exc)
    return FileContentResponse(project_id=project_id, **fields)


@router.get(
    "/projects/{project_id}/search",
    response_model=SearchResponse,
    status_code=200,
    summary="项目全文搜索（大小写不敏感子串，按行匹配）",
    responses={
        400: {"description": "关键词为空或超长"},
        404: {"description": "项目不存在"},
    },
)
def search_in_project(
    project_id: str,
    request: Request,
    q: str = Query(min_length=1, max_length=200),
) -> SearchResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
        result = search_project(root, q)
    except FileServiceError as exc:
        _translate(exc)
    except SearchServiceError as exc:
        raise ApiError(exc.code, exc.message) from exc
    return SearchResponse(**result)


@router.post(
    "/projects/{project_id}/diagnose",
    response_model=DiagnoseResponse,
    status_code=200,
    summary="检查未保存的 Python 草稿文本（不写入电脑文件）",
    responses={
        400: {"description": "路径不符合合同规则或内容缺失"},
        404: {"description": "项目不存在"},
        413: {"description": "草稿内容超过 1 MiB"},
    },
)
def diagnose_draft(
    project_id: str,
    request: Request,
    body: DiagnoseRequest,
) -> DiagnoseResponse:
    store = request.app.state.store
    try:
        # 只做项目级鉴权与路径语法校验：草稿尚未保存，服务端不读盘
        project_root_or_404(store, project_id)
        validate_relative_path(body.path)
    except FileServiceError as exc:
        _translate(exc)
    except PathGuardError as exc:
        raise ApiError(exc.code, exc.message) from exc
    try:
        result = diagnose_python_source(body.content)
    except DiagnoseServiceError as exc:
        raise ApiError(exc.code, exc.message) from exc
    return DiagnoseResponse(**result)


@router.get(
    "/projects/{project_id}/git/status",
    response_model=GitStatusResponse,
    status_code=200,
    summary="项目 Git 状态（只读；不是仓库时 available=false）",
)
def get_git_status(project_id: str, request: Request) -> GitStatusResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
    except FileServiceError as exc:
        _translate(exc)
    result = git_status(root)
    return GitStatusResponse(**result)


@router.get(
    "/projects/{project_id}/git/diff",
    response_model=GitDiffResponse,
    status_code=200,
    summary="单个文件的未提交 Diff（unified 文本）",
    responses={
        400: {"description": "路径不符合合同规则"},
        "500": {"description": "git 命令失败"},
    },
)
def get_git_diff(
    project_id: str,
    request: Request,
    path: str = Query(min_length=1, max_length=512),
    staged: bool = False,
) -> GitDiffResponse:
    try:
        validate_relative_path(path)
    except PathGuardError as exc:
        raise ApiError(exc.code, exc.message) from exc
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
    except FileServiceError as exc:
        _translate(exc)
    try:
        result = git_diff(root, path, staged)
    except GitServiceError as exc:
        raise ApiError(exc.code, exc.message) from exc
    return GitDiffResponse(**result)


__all__ = ["router", "DeviceIdentity"]
