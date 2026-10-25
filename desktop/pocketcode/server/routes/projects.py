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
    FileContentResponse,
    ManifestResponse,
    ProjectListResponse,
    ProjectSummary,
)
from pocketcode.services.files import (
    FileServiceError,
    generate_manifest,
    manifest_signature,
    project_root_or_404,
    read_text_file,
)

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


__all__ = ["router", "DeviceIdentity"]
