"""写入类端点（S3a）：保存、新建、回收区。全部要求设备鉴权。

同项目同路径的并发写用 per-path 互斥串行化；回收区/快照目录都在设置目录旁，
不在任何授权项目内，手机不可见。
"""

from __future__ import annotations

import threading
import uuid
from contextlib import contextmanager
from typing import Iterator

from pathlib import Path

from fastapi import APIRouter, Depends, Request

from pocketcode.security.auth import require_device
from pocketcode.security.path_guard import PathGuardError, resolve_under_root, validate_relative_path
from pocketcode.server.errors import ApiError
from pocketcode.server.schemas import (
    FileCreateRequest,
    FileCreateResponse,
    FileSaveRequest,
    FileSaveResponse,
    RestoreResponse,
    TrashEntry,
    TrashListResponse,
    TrashRequest,
    TrashResponse,
)
from pocketcode.services.files import FileServiceError, project_root_or_404
from pocketcode.services.trash import TrashServiceError, TrashStore
from pocketcode.services.writes import WriteServiceError, create_entry, save_file

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device)])

_path_locks: dict[str, threading.Lock] = {}
_path_locks_guard = threading.Lock()


@contextmanager
def _path_lock(key: str) -> Iterator[None]:
    with _path_locks_guard:
        lock = _path_locks.setdefault(key, threading.Lock())
    with lock:
        yield


def _translate_service_error(exc: Exception) -> ApiError:
    if isinstance(exc, (WriteServiceError, FileServiceError, TrashServiceError)):
        raise ApiError(exc.code, exc.message, getattr(exc, "details", None)) from exc
    raise exc


def _bump_revision(request: Request, project_id: str) -> int:
    """树结构变更（新建/删除）后递增 manifest 序号；签名置为一次性值，下次
    manifest 生成会再次校准，保证单调不回退。"""
    store = request.app.state.store
    return store.record_manifest_revision(project_id, f"mutation:{uuid.uuid4().hex}")


def _trash_store(request: Request) -> TrashStore:
    store = request.app.state.store
    return TrashStore(store.path.parent / "trash")


@router.put(
    "/projects/{project_id}/file",
    response_model=FileSaveResponse,
    status_code=200,
    summary="保存文件（带版本冲突检测）",
    responses={
        403: {"description": "路径越界"},
        404: {"description": "项目或文件不存在"},
        409: {"description": "base_version 已过期"},
        413: {"description": "内容超限"},
        415: {"description": "不支持的编码"},
    },
)
def put_file(project_id: str, request: Request, body: FileSaveRequest) -> FileSaveResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
        validate_relative_path(body.path)
    except FileServiceError as exc:
        _translate_service_error(exc)
    except PathGuardError as exc:
        raise ApiError(exc.code, exc.message) from exc

    snapshots_root = store.path.parent / "snapshots"
    with _path_lock(f"{project_id}:{body.path.lower()}"):
        try:
            fields = save_file(
                root,
                body.path,
                body.base_version,
                body.content,
                body.encoding,
                body.newline,
                project_id=project_id,
                snapshots_root=snapshots_root,
            )
        except WriteServiceError as exc:
            _translate_service_error(exc)
    return FileSaveResponse(**fields)


@router.post(
    "/projects/{project_id}/files",
    response_model=FileCreateResponse,
    status_code=201,
    summary="新建文件或目录",
    responses={
        403: {"description": "路径越界"},
        409: {"description": "目标已存在"},
        413: {"description": "初始内容超限"},
        415: {"description": "不支持的编码"},
    },
)
def post_files(project_id: str, request: Request, body: FileCreateRequest) -> FileCreateResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
        validate_relative_path(body.path)
    except FileServiceError as exc:
        _translate_service_error(exc)
    except PathGuardError as exc:
        raise ApiError(exc.code, exc.message) from exc

    try:
        fields = create_entry(
            root,
            body.path,
            body.type,
            content=body.content,
            encoding=body.encoding,
            newline=body.newline,
        )
    except WriteServiceError as exc:
        _translate_service_error(exc)
    return FileCreateResponse(
        path=fields["path"],
        type=fields["type"],
        version=fields.get("version"),
        manifest_revision=_bump_revision(request, project_id),
    )


@router.post(
    "/projects/{project_id}/trash",
    response_model=TrashResponse,
    status_code=200,
    summary="把文件/目录移入专用回收区（批量原子）",
    responses={
        403: {"description": "路径越界"},
        404: {"description": "项目不存在或批次中某路径不存在"},
    },
)
def post_trash(project_id: str, request: Request, body: TrashRequest) -> TrashResponse:
    store = request.app.state.store
    try:
        root = project_root_or_404(store, project_id)
    except FileServiceError as exc:
        _translate_service_error(exc)

    resolved: list[tuple[str, Path]] = []
    for path in body.paths:
        try:
            validate_relative_path(path)
            absolute = resolve_under_root(root, path)
        except PathGuardError as exc:
            raise ApiError(exc.code, exc.message, {"path": path}) from exc
        if not absolute.exists():
            raise ApiError(
                "FILE_NOT_FOUND", "批次中存在不存在的路径，整批未执行", {"path": path}
            )
        resolved.append((path, absolute))

    moved = _trash_store(request).move_in(
        project_id, [(rel, abs_path) for rel, abs_path in resolved]
    )
    _bump_revision(request, project_id)
    return TrashResponse(items=moved)


@router.get(
    "/trash",
    response_model=TrashListResponse,
    status_code=200,
    summary="列出回收区条目（跨会话持久）",
)
def get_trash(request: Request) -> TrashListResponse:
    entries = _trash_store(request).list_entries()
    return TrashListResponse(
        items=[
            TrashEntry(
                trash_id=entry["trash_id"],
                project_id=entry["project_id"],
                original_path=entry["original_path"],
                deleted_at=entry["deleted_at"],
                kind=entry["kind"],
                size=entry.get("size"),
            )
            for entry in entries
        ]
    )


@router.post(
    "/trash/{trash_id}/restore",
    response_model=RestoreResponse,
    status_code=200,
    summary="从回收区恢复到原路径",
    responses={
        404: {"description": "trash_id 无效"},
        409: {"description": "原路径被占用"},
    },
)
def post_restore(trash_id: str, request: Request) -> RestoreResponse:
    try:
        _restored_id, restored_path = _trash_store(request).restore(trash_id)
    except TrashServiceError as exc:
        _translate_service_error(exc)
    return RestoreResponse(trash_id=trash_id, restored_path=restored_path)


@router.delete(
    "/trash/{trash_id}",
    status_code=204,
    summary="永久删除单条回收区条目（不可恢复）",
)
def delete_trash_entry(trash_id: str, request: Request) -> None:
    if not _trash_store(request).delete_entry(trash_id):
        raise ApiError("NOT_FOUND", "回收区中不存在该条目")
    return None


@router.delete("/trash", status_code=204, summary="清空回收区（不可恢复）")
def delete_trash(request: Request) -> None:
    _trash_store(request).purge()
    return None
