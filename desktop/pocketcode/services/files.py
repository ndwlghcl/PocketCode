"""只读文件服务（S2c）：manifest 目录树与文本文件读取。

过滤规则（PRD：跳过依赖/虚拟环境/构建产物，默认排除敏感文件）：
- 目录：.git、node_modules、venv、__pycache__、build/dist、IDE 目录等；
- 任何以 `.` 开头的隐藏文件/目录（.env 等密钥文件由此被挡住）；
- 按扩展名排除证书/密钥类文件（pem/key/p12/pfx/keystore）。

版本（version）：文件原始字节的 SHA-256；按 (大小, mtime_ns) 做进程内缓存，
重复生成 manifest 不必重复读盘哈希（大仓库性能保护，架构文档 §8）。
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path

from pocketcode.security.path_guard import PathGuardError, resolve_under_root

MAX_FILE_BYTES = 4 * 1024 * 1024  # 与 contracts/openapi.yaml 的 4 MiB 上限一致
MAX_MANIFEST_ENTRIES = 100_000
_BOM_UTF8 = b"\xef\xbb\xbf"
_BOM_UTF16_LE = b"\xff\xfe"
_BOM_UTF16_BE = b"\xfe\xff"

IGNORED_DIR_NAMES = {
    ".git", ".hg", ".svn", ".idea", ".vscode",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox",
    "node_modules", "bower_components",
    "venv", ".venv", "env", ".env2",  # .env2 仅为防误配；主要靠隐藏目录规则
    "build", "dist", "out", "target", ".gradle", ".next", "vendor",
}
IGNORED_FILE_EXTENSIONS = {
    ".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".crt",
}


class FileServiceError(Exception):
    """code 取合同错误码；路由层转成统一错误响应。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


class _Counter:
    __slots__ = ("count", "limit")

    def __init__(self, limit: int) -> None:
        self.count = 0
        self.limit = limit

    def take(self) -> bool:
        """占用一个条目名额；超过上限返回 False。"""
        if self.count >= self.limit:
            return False
        self.count += 1
        return True


def _should_ignore_dir(name: str) -> bool:
    return name.startswith(".") or name.lower() in IGNORED_DIR_NAMES


def _should_ignore_file(name: str) -> bool:
    return name.startswith(".") or Path(name).suffix.lower() in IGNORED_FILE_EXTENSIONS


def _iso_time(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


class _VersionCache:
    """(绝对路径, size, mtime_ns) → sha256 前缀的进程内缓存。"""

    def __init__(self, max_entries: int = 20_000) -> None:
        self._max = max_entries
        self._entries: dict[tuple[str, int, int], str] = {}

    def version_of(self, path: Path) -> str:
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns)
        cached = self._entries.get(key)
        if cached is not None:
            return cached
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        version = "sha256:" + digest.hexdigest()
        if len(self._entries) >= self._max:
            self._entries.clear()  # 简单防膨胀：清空重来，正确性不受影响
        self._entries[key] = version
        return version


_VERSION_CACHE = _VersionCache()


def generate_manifest(root: Path) -> tuple[dict, bool]:
    """构建目录快照。返回 (root_node, truncated)。"""
    counter = _Counter(MAX_MANIFEST_ENTRIES)
    truncated = False

    def build_dir(dir_path: Path, name: str, rel: str) -> dict:
        nonlocal truncated
        node = {"type": "dir", "name": name, "path": rel, "children": []}
        if not counter.take():
            truncated = True
            return node
        try:
            entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
        except OSError as exc:
            raise FileServiceError("IO_ERROR", f"目录不可读：{dir_path.name}") from exc
        for entry in entries:
            rel_child = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir(follow_symlinks=False):
                if _should_ignore_dir(entry.name):
                    continue
                node["children"].append(
                    build_dir(Path(entry.path), entry.name, rel_child)
                )
            else:
                if _should_ignore_file(entry.name):
                    continue
                if not counter.take():
                    truncated = True
                    continue
                try:
                    stat = entry.stat()
                except OSError:
                    continue  # 竞态：扫描期间被删除的文件直接跳过
                node["children"].append(
                    {
                        "type": "file",
                        "name": entry.name,
                        "path": rel_child,
                        "size": stat.st_size,
                        "mtime": _iso_time(stat.st_mtime),
                        "version": _VERSION_CACHE.version_of(Path(entry.path)),
                        "read_only": not os.access(entry.path, os.W_OK),
                    }
                )
        return node

    return build_dir(root, "", ""), truncated


def project_root_or_404(store, project_id: str) -> Path:
    """project_id → 授权根目录；未注册或目录不存在时抛错。"""
    for project in store.load().authorized_projects:
        if project.id == project_id:
            root = Path(project.root_path)
            if not root.is_dir():
                raise FileServiceError("IO_ERROR", "项目目录不存在或不可访问")
            return root
    raise FileServiceError("PROJECT_NOT_FOUND", "项目不存在或未授权")


def manifest_signature(root_node: dict) -> str:
    import json

    canonical = json.dumps(root_node, ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def read_text_file(root: Path, relative_path: str) -> dict:
    """按合同读取一个文本文件；二进制/超限/越界各自抛对应错误。"""
    try:
        target = resolve_under_root(root, relative_path)
    except PathGuardError as exc:
        raise FileServiceError(exc.code, exc.message) from exc

    if not target.exists() or target.is_dir():
        raise FileServiceError("FILE_NOT_FOUND", "文件不存在（或该路径是目录）")

    size = target.stat().st_size
    if size > MAX_FILE_BYTES:
        raise FileServiceError("FILE_TOO_LARGE", f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)} MiB 上限")

    raw = target.read_bytes()
    encoding, text = _decode(raw)
    version = _VERSION_CACHE.version_of(target)
    if "\r\n" in text:
        newline = "CRLF"
    elif "\r" in text:
        newline = "CR"
    else:
        newline = "LF"
    return {
        "path": relative_path,
        "content": text,
        "encoding": encoding,
        "newline": newline,
        "version": version,
        "size": size,
        "mtime": _iso_time(target.stat().st_mtime),
        "read_only": not os.access(target, os.W_OK),
    }


def _decode(raw: bytes) -> tuple[str, str]:
    """返回 (encoding, text)；无法安全解码抛 UNSUPPORTED_FORMAT。"""
    if raw.startswith(_BOM_UTF8):
        return "utf-8-bom", raw[3:].decode("utf-8")
    if raw.startswith(_BOM_UTF16_LE):
        return "utf-16-le", raw[2:].decode("utf-16-le")
    if raw.startswith(_BOM_UTF16_BE):
        return "utf-16-be", raw[2:].decode("utf-16-be")
    try:
        return "utf-8", raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FileServiceError(
            "UNSUPPORTED_FORMAT", "该文件是二进制或使用不支持的编码，无法以文本打开"
        ) from exc
