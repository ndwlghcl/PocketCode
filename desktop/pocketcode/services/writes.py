"""写入服务（S3a）：保存文件（冲突检测/编码换行恢复/原子写入）与新建文件/目录。

写入协议（架构文档 §5）：
读取原始字节 → 客户端持有 base_version → 写入前复查 → 创建可恢复快照 →
同目录临时文件刷盘 → 原子替换 → 返回新 version。
同项目同路径的写操作由接口层互斥（见 routes/mutations.py 的 per-path 锁）；
外部 IDE 不遵守锁，靠"最终替换前复查 + 快照"兜底。
这仍是乐观并发控制；最终复核与原子替换之间不具有跨进程 CAS 语义。

内容换行约定（合同 FileSaveRequest）：content 中换行一律以 LF 表示；
服务端先归一化（\r\n、\r → \n），再按 newline 字段恢复目标风格——
移动端 textarea 会把 CRLF 归一成 LF，这个约定使手机保存 CRLF 文件不丢格式。
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from pocketcode.security.path_guard import resolve_under_root
from pocketcode.services.files import (
    MAX_FILE_BYTES,
    _VERSION_CACHE,
    _iso_time,
)
from pocketcode.services.snapshots import snapshot_previous


class WriteServiceError(Exception):
    """code 取合同错误码；路由层转成统一错误响应。"""

    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        self.code = code
        self.message = message
        self.details = details
        super().__init__(f"[{code}] {message}")


def _normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _apply_newline(text: str, newline: str) -> str:
    normalized = _normalize_newlines(text)
    if newline == "CRLF":
        return normalized.replace("\n", "\r\n")
    if newline == "CR":
        return normalized.replace("\n", "\r")
    return normalized


def _encode(text: str, encoding: str) -> bytes:
    """按目标编码产出原始字节；utf-8-bom/utf-16 由服务端负责补 BOM。"""
    if encoding == "utf-8":
        return text.encode("utf-8")
    if encoding == "utf-8-bom":
        return b"\xef\xbb\xbf" + text.encode("utf-8")
    if encoding == "utf-16-le":
        return b"\xff\xfe" + text.encode("utf-16-le")
    if encoding == "utf-16-be":
        return b"\xfe\xff" + text.encode("utf-16-be")
    raise WriteServiceError("UNSUPPORTED_FORMAT", f"不支持的编码：{encoding}")


def save_file(
    root: Path,
    relative_path: str,
    base_version: str,
    content: str,
    encoding: str,
    newline: str,
    *,
    project_id: str,
    snapshots_root: Path,
) -> dict:
    """带冲突检测地保存一个已存在的文本文件。返回 FileSaveResponse 字段。"""
    target = resolve_under_root(root, relative_path)
    if not target.exists() or target.is_dir():
        raise WriteServiceError("FILE_NOT_FOUND", "文件不存在（或该路径是目录）")

    current_bytes = target.read_bytes()
    current_version = "sha256:" + hashlib_sha256(current_bytes)
    if current_version != base_version:
        raise WriteServiceError(
            "VERSION_CONFLICT",
            "电脑文件已在别处修改，未执行覆盖",
            {"current_version": current_version, "base_version": base_version},
        )

    new_bytes = _encode(_apply_newline(content, newline), encoding)
    if len(new_bytes) > MAX_FILE_BYTES:
        raise WriteServiceError(
            "FILE_TOO_LARGE",
            f"保存内容超过 {MAX_FILE_BYTES // (1024 * 1024)} MiB 上限",
        )

    snapshot_previous(snapshots_root, project_id, relative_path, current_bytes)

    # 同目录临时文件 + 原子替换（Windows os.replace 原子）
    tmp = target.with_name(f".pocketcode-tmp-{uuid.uuid4().hex[:12]}")
    try:
        with tmp.open("wb") as handle:
            handle.write(new_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        # 外部 IDE 不遵守服务内路径锁。快照/刷盘可能耗时，提交前必须复核。
        latest_target = resolve_under_root(root, relative_path)
        if latest_target != target or not target.is_file():
            raise WriteServiceError("VERSION_CONFLICT", "保存期间电脑文件的位置发生变化，未执行覆盖")
        latest_bytes = target.read_bytes()
        latest_version = "sha256:" + hashlib_sha256(latest_bytes)
        if latest_version != base_version:
            raise WriteServiceError(
                "VERSION_CONFLICT", "保存期间电脑文件已修改，未执行覆盖",
                {"current_version": latest_version, "base_version": base_version},
            )
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

    stat = target.stat()
    version = "sha256:" + hashlib_sha256(new_bytes)
    _VERSION_CACHE.version_of(target)  # 预热缓存
    return {
        "path": relative_path,
        "version": version,
        "size": stat.st_size,
        "mtime": _iso_time(stat.st_mtime),
    }


def create_entry(
    root: Path,
    relative_path: str,
    entry_type: str,
    content: str = "",
    encoding: str = "utf-8",
    newline: str = "LF",
) -> dict:
    """新建文件或目录；自动创建缺失父目录；已存在时拒绝覆盖。"""
    target = resolve_under_root(root, relative_path)
    if target.exists():
        raise WriteServiceError(
            "ALREADY_EXISTS", "目标已存在，未做任何覆盖", {"occupied_path": relative_path}
        )

    if entry_type == "dir":
        target.mkdir(parents=True, exist_ok=False)
        return {"path": relative_path, "type": "dir"}

    new_bytes = _encode(_apply_newline(content, newline), encoding)
    if len(new_bytes) > MAX_FILE_BYTES:
        raise WriteServiceError(
            "FILE_TOO_LARGE",
            f"初始内容超过 {MAX_FILE_BYTES // (1024 * 1024)} MiB 上限",
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".pocketcode-tmp-{uuid.uuid4().hex[:12]}")
    try:
        tmp.write_bytes(new_bytes)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

    stat = target.stat()
    return {
        "path": relative_path,
        "type": "file",
        "version": "sha256:" + hashlib_sha256(new_bytes),
        "size": stat.st_size,
        "mtime": _iso_time(stat.st_mtime),
    }


def hashlib_sha256(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()
