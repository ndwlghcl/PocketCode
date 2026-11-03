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
        try:
            target.mkdir(parents=True, exist_ok=False)
        except FileExistsError as exc:
            raise WriteServiceError("ALREADY_EXISTS", "目标已存在，未做任何覆盖") from exc
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
        with tmp.open("xb") as handle:
            handle.write(new_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        if resolve_under_root(root, relative_path) != target:
            raise WriteServiceError("PATH_FORBIDDEN", "新建期间目标位置发生变化")
        # 同目录硬链接发布完整内容；目标存在时由文件系统原子拒绝。
        # 不可回退到 os.replace：外部 IDE 不遵守服务内部的锁。
        try:
            os.link(tmp, target)
        except FileExistsError as exc:
            raise WriteServiceError("ALREADY_EXISTS", "目标已存在，未做任何覆盖", {"occupied_path": relative_path}) from exc
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


def _rename_exclusive(source: Path, target: Path) -> None:
    """原子移动且不覆盖；不支持的平台宁可失败，也不回退到 replace。"""
    if os.name == "nt":
        # Windows rename 的目标已存在时会失败，包含外部程序的竞态。
        os.rename(source, target)
        return
    import ctypes
    import errno
    import sys

    if sys.platform != "linux":
        raise WriteServiceError("IO_ERROR", "当前系统不支持安全的不覆盖移动")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise WriteServiceError("IO_ERROR", "当前文件系统不支持安全的不覆盖移动")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, os.strerror(code), str(target))
        raise OSError(code, os.strerror(code))


def _unlinked_path(root: Path, relative_path: str) -> Path:
    import stat

    if any(char in relative_path for char in ':*?"<>|'):
        raise WriteServiceError("PATH_INVALID", "移动路径不能包含 Windows 非法字符或数据流名称")
    resolved = resolve_under_root(root, relative_path)
    current = root.resolve(strict=True)
    for part in relative_path.split("/"):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise WriteServiceError("PATH_FORBIDDEN", "移动路径不能经过符号链接或重解析点")
    return resolved


def move_file(root: Path, path: str, target_path: str, base_version: str) -> dict:
    """正文不重写；来源版本检查 + 目标不覆盖，现有草稿由手机单独保留。"""
    source = _unlinked_path(root, path)
    target = _unlinked_path(root, target_path)
    if source == target:
        raise WriteServiceError("ALREADY_EXISTS", "目标与来源相同；请使用不同的新路径")
    if not source.is_file():
        raise WriteServiceError("FILE_NOT_FOUND", "来源普通文件不存在")
    if target.exists():
        raise WriteServiceError("ALREADY_EXISTS", "目标已存在，未覆盖")
    if not target.parent.is_dir():
        raise WriteServiceError("FILE_NOT_FOUND", "目标文件夹不存在，请先创建文件夹")
    if source.stat().st_size > MAX_FILE_BYTES:
        raise WriteServiceError("FILE_TOO_LARGE", "移动文件超过 4 MiB 上限")
    with source.open("rb") as handle:
        content = handle.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise WriteServiceError("FILE_TOO_LARGE", "移动文件超过 4 MiB 上限")
    version = "sha256:" + hashlib_sha256(content)
    if version != base_version:
        raise WriteServiceError("VERSION_CONFLICT", "来源文件已修改，请刷新目录后重试", {"current_version": version})
    # 再次检查路径；外部程序不遵守服务锁，版本检查仍是乐观并发控制。
    if _unlinked_path(root, path) != source or _unlinked_path(root, target_path) != target:
        raise WriteServiceError("PATH_FORBIDDEN", "移动期间文件位置发生变化")
    try:
        _rename_exclusive(source, target)
    except FileExistsError as exc:
        raise WriteServiceError("ALREADY_EXISTS", "目标已存在，未覆盖") from exc
    except OSError as exc:
        if target.exists():
            raise WriteServiceError("ALREADY_EXISTS", "目标已存在，未覆盖") from exc
        if not source.exists():
            raise WriteServiceError("FILE_NOT_FOUND", "移动期间来源文件已不存在") from exc
        raise WriteServiceError("IO_ERROR", "移动失败，请检查文件占用、权限或文件系统支持") from exc
    return {"path": path, "target_path": target_path, "version": version}
