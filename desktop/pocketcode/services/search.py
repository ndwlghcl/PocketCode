"""项目全文搜索（S4b）：大小写不敏感的子串按行匹配。

扫描范围与 manifest 一致（files.py 的目录/文件过滤规则），只搜可安全解码
的文本文件（复用 files._decode；二进制/不支持的编码静默跳过）。符号链接
文件一律跳过（与 path_guard「不越出授权根目录」的口径一致）。
限额写入合同 description：扫描文件数 / 单文件匹配数 / 总匹配数；
触限时 truncated=true，客户端必须如实提示"结果不完整"。
"""

from __future__ import annotations

import os
from pathlib import Path
from pocketcode.security.path_guard import scan_entry_under_root

from pocketcode.services.files import _decode, _should_ignore_dir, _should_ignore_file

MAX_SCAN_FILES = 3000
MAX_MATCHES_PER_FILE = 20
MAX_TOTAL_MATCHES = 200
MAX_SCAN_FILE_BYTES = 1024 * 1024
MAX_QUERY_CHARS = 200


class SearchServiceError(Exception):
    """code 取合同错误码；路由层转成统一错误响应。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")


def normalize_query(query: str) -> str:
    """去除首尾空白；为空/超长抛 INVALID_REQUEST（400）。"""
    if not isinstance(query, str):
        raise SearchServiceError("INVALID_REQUEST", "搜索关键词缺失")
    trimmed = query.strip()
    if not trimmed:
        raise SearchServiceError("INVALID_REQUEST", "搜索关键词不能为空")
    if len(trimmed) > MAX_QUERY_CHARS:
        raise SearchServiceError(
            "INVALID_REQUEST", f"搜索关键词超过 {MAX_QUERY_CHARS} 字符"
        )
    return trimmed


def search_project(root: Path, query: str) -> dict:
    """返回 SearchResponse 字段（不含 project_id——那是路由层知道的）。"""
    root = root.resolve(strict=True)
    normalized = normalize_query(query)
    needle = normalized.lower()
    matches: list[dict] = []
    total = 0
    scanned = 0
    truncated = False

    def walk(dir_path: Path, rel: str) -> None:
        nonlocal scanned, total, truncated
        if truncated:
            return
        try:
            entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
        except OSError:
            return  # 不可读目录：与 manifest 一致地跳过
        for entry in entries:
            if truncated:
                return
            safe_path = scan_entry_under_root(root, entry)
            if safe_path is None:
                continue
            rel_child = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir(follow_symlinks=False):
                if not _should_ignore_dir(entry.name):
                    walk(safe_path, rel_child)
                continue
            if _should_ignore_file(entry.name) or entry.is_symlink():
                continue
            if scanned >= MAX_SCAN_FILES:
                truncated = True
                return
            try:
                if entry.stat(follow_symlinks=False).st_size > MAX_SCAN_FILE_BYTES:
                    truncated = True
                    continue
                scanned += 1
                raw = safe_path.read_bytes()
            except OSError:
                continue
            try:
                _encoding, text = _decode(raw)
            except Exception:  # noqa: BLE001 - 二进制/不支持编码：静默跳过
                continue

            file_hits: list[dict] = []
            for line_no, line in enumerate(text.splitlines(), start=1):
                if needle in line.lower():
                    file_hits.append({"line": line_no, "text": line})
                    if len(file_hits) >= MAX_MATCHES_PER_FILE:
                        truncated = True
                        break
            if file_hits:
                if total + len(file_hits) > MAX_TOTAL_MATCHES:
                    file_hits = file_hits[: MAX_TOTAL_MATCHES - total]
                    truncated = True
                matches.append({"path": rel_child, "lines": file_hits})
                total += len(file_hits)
                if total >= MAX_TOTAL_MATCHES:
                    truncated = True

    walk(root, "")
    return {
        "query": normalized,
        "total_matches": total,
        "truncated": truncated,
        "matches": matches,
    }
